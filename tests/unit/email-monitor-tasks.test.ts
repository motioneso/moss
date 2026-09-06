import { describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";
import {
  DEFAULT_EMAIL_TASK_MODE,
  createEmailActionSubjectSignature,
  emailActionResurfaceKey,
  resetAcceptedSuppression,
  emailSourceRef,
  emailTaskExternalKey,
  parseEmailSourceRef,
  parseEmailTaskMode,
  planEmailTasks,
  runEmailMonitor,
  MONITOR_STATUS_PREF_KEY,
  type MonitorPreferencesPort,
  type RunEmailMonitorDeps,
  type EmailContextItem,
  type EmailActionSuppressionSnapshot
} from "@moss/connectors";

const NOW = "2026-07-04T12:00:00.000Z";
const DB = {} as DataContextDb;

function item(overrides: Partial<EmailContextItem> = {}): EmailContextItem {
  return {
    messageKey: "msg-1",
    account: { connectorAccountId: "acct-1", providerId: "google", providerLabel: "Gmail" },
    sender: "boss@work.example",
    recipients: ["me@self.example"],
    subject: "Budget approval needed",
    receivedAt: "2026-07-04T09:00:00.000Z",
    threadId: null,
    sourceHref: "https://mail.google.com/mail/u/0/#all/thread-1",
    snippet: null,
    summary: "Approve the Q3 budget by Friday",
    actionability: "needs_action",
    importance: "normal",
    confidence: 0.9,
    reason: "Asks you to approve the budget",
    inferredSubject: "Budget approval",
    dueDate: null,
    suggestedTasks: [{ title: "Approve Q3 budget", dueDate: "2026-07-10T00:00:00.000Z" }],
    source: "live",
    degradedReason: null,
    cacheMessageId: "cache-msg-1",
    ...overrides
  };
}

function plan(
  items: EmailContextItem[],
  mode: Parameters<typeof planEmailTasks>[0]["mode"],
  rejectionAggregates: Parameters<typeof planEmailTasks>[0]["rejectionAggregates"] = [],
  extras: Pick<Parameters<typeof planEmailTasks>[0], "suppressionStates" | "resurfaceReasons"> = {}
) {
  return planEmailTasks({ items, mode, rejectionAggregates, now: NOW, ...extras });
}

describe("parseEmailTaskMode", () => {
  it("passes valid modes through and defaults everything else to suggest", () => {
    expect(parseEmailTaskMode("off")).toBe("off");
    expect(parseEmailTaskMode("auto_safe")).toBe("auto_safe");
    expect(parseEmailTaskMode("auto")).toBe("auto");
    expect(parseEmailTaskMode("banana")).toBe("suggest");
    expect(parseEmailTaskMode(null)).toBe("suggest");
    expect(parseEmailTaskMode(42)).toBe("suggest");
    expect(DEFAULT_EMAIL_TASK_MODE).toBe("suggest");
  });
});

describe("emailTaskExternalKey", () => {
  it("is deterministic and normalizes the action title", () => {
    expect(emailTaskExternalKey("acct-1", "msg-9", "Pay the Bill!")).toBe(
      "acct-1:msg-9:pay-the-bill"
    );
    expect(emailTaskExternalKey("acct-1", "msg-9", "Pay the Bill!")).toBe(
      emailTaskExternalKey("acct-1", "msg-9", "  pay THE bill?? ")
    );
  });

  it("caps the normalized segment at 40 chars", () => {
    const key = emailTaskExternalKey("a", "m", "x".repeat(120));
    expect(key).toBe(`a:m:${"x".repeat(40)}`);
  });
});

describe("emailSourceRef / parseEmailSourceRef", () => {
  it("round-trips connector account id and external id", () => {
    const ref = emailSourceRef("acct-1", "msg-9");
    expect(ref).toBe("acct-1:msg-9");
    expect(parseEmailSourceRef(ref)).toEqual({ connectorAccountId: "acct-1", externalId: "msg-9" });
  });

  it("distinguishes two accounts sharing the same external id (email_messages is unique per account, not globally)", () => {
    const refA = emailSourceRef("acct-a", "shared-external-id");
    const refB = emailSourceRef("acct-b", "shared-external-id");
    expect(refA).not.toBe(refB);
    expect(parseEmailSourceRef(refA)).toEqual({
      connectorAccountId: "acct-a",
      externalId: "shared-external-id"
    });
    expect(parseEmailSourceRef(refB)).toEqual({
      connectorAccountId: "acct-b",
      externalId: "shared-external-id"
    });
  });

  it("preserves a colon inside the external id itself", () => {
    const ref = emailSourceRef("acct-1", "provider:weird:id");
    expect(parseEmailSourceRef(ref)).toEqual({
      connectorAccountId: "acct-1",
      externalId: "provider:weird:id"
    });
  });

  it("returns null for a malformed ref with no separator", () => {
    expect(parseEmailSourceRef("no-separator-here")).toBeNull();
  });
});

describe("planEmailTasks — candidate selection", () => {
  it("mode off plans nothing", () => {
    expect(plan([item()], "off")).toEqual([]);
  });

  it("plans needs_action and needs_reply candidates in suggest mode as suggested", () => {
    const planned = plan(
      [
        item(),
        item({
          messageKey: "msg-2",
          actionability: "needs_reply",
          suggestedTasks: [{ title: "Reply to Sam", dueDate: null }]
        })
      ],
      "suggest"
    );
    expect(planned).toHaveLength(2);
    expect(planned.every((t) => t.status === "suggested")).toBe(true);
    expect(planned[0]?.sourceRef).toBe(emailSourceRef("acct-1", "msg-1"));
    expect(planned[0]?.externalKey).toBe(
      emailTaskExternalKey("acct-1", "msg-1", "Approve Q3 budget")
    );
  });

  it("never plans noise, fyi, waiting_on_someone, or unknown", () => {
    const planned = plan(
      [
        item({ actionability: "noise", subject: "MEGA SALE 50% off" }),
        item({ actionability: "fyi", messageKey: "msg-2" }),
        item({ actionability: "waiting_on_someone", messageKey: "msg-3" }),
        item({ actionability: "unknown", messageKey: "msg-4" })
      ],
      "auto"
    );
    expect(planned).toEqual([]);
  });

  it("plans time_sensitive_info only at high confidence with a due date or suggested task", () => {
    const highWithDue = item({
      actionability: "time_sensitive_info",
      confidence: 0.8,
      suggestedTasks: [{ title: "Check in for the flight", dueDate: null }],
      dueDate: "2026-07-05T00:00:00.000Z",
      subject: "Flight check-in closes tomorrow"
    });
    const lowConfidence = item({
      actionability: "time_sensitive_info",
      confidence: 0.5,
      messageKey: "msg-2",
      dueDate: "2026-07-05T00:00:00.000Z"
    });
    const planned = plan([highWithDue, lowConfidence], "suggest");
    expect(planned).toHaveLength(1);
    expect(planned[0]?.title).toBe("Check in for the flight");
  });

  it("skips candidates without a suggested task or due date, and confidence below 0.4", () => {
    const planned = plan(
      [item({ suggestedTasks: [], dueDate: null }), item({ messageKey: "msg-2", confidence: 0.3 })],
      "suggest"
    );
    expect(planned).toEqual([]);
  });

  it("plans one task per suggested task candidate with distinct external keys", () => {
    const planned = plan(
      [
        item({
          suggestedTasks: [
            { title: "Approve Q3 budget", dueDate: null },
            { title: "Forward to finance", dueDate: null }
          ]
        })
      ],
      "suggest"
    );
    expect(planned).toHaveLength(2);
    expect(new Set(planned.map((t) => t.externalKey)).size).toBe(2);
  });

  it("counts a cached IMAP candidate without a source link", () => {
    const planned = plan(
      [
        item({
          account: { connectorAccountId: "acct-1", providerId: "imap", providerLabel: "IMAP" },
          sourceHref: null
        })
      ],
      "suggest"
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]?.suggestionMetadata.sourceHref).toBeNull();
  });

  it("omits a candidate without a cache message id", () => {
    expect(plan([item({ sourceHref: null, cacheMessageId: null })], "suggest")).toEqual([]);
  });
});

describe("planEmailTasks — sender volume", () => {
  it("never hides or demotes a candidate because of sender-domain volume", () => {
    const planned = plan([item({ sender: "a@noisy.example", confidence: 0.9 })], "auto", [
      { senderDomain: "noisy.example", rejected: 99, accepted: 0 }
    ]);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.status).toBe("todo");
  });
});

describe("planEmailTasks — subject suppression", () => {
  it("suppresses exact subject after two dismissals and ignores volume", () => {
    const signature = createEmailActionSubjectSignature("Budget approval");
    expect(
      plan(
        [item({ sender: "alerts.noisy.example@example.com" })],
        "suggest",
        [{ senderDomain: "example.com", rejected: 99, accepted: 0 }],
        {
          suppressionStates: [
            {
              subjectSignature: signature,
              dismissalCount: 2,
              lastDeadlineEvidenceKey: null,
              lastContextMessageKey: null,
              deadlineEvidenceKeys: [],
              contextMessageKeys: []
            }
          ]
        }
      )
    ).toEqual([]);
  });

  it("resurfaces once for new due-tomorrow evidence", () => {
    const signature = createEmailActionSubjectSignature("Budget approval");
    const planned = plan([item()], "suggest", [], {
      suppressionStates: [
        {
          subjectSignature: signature,
          dismissalCount: 2,
          lastDeadlineEvidenceKey: null,
          lastContextMessageKey: null,
          deadlineEvidenceKeys: [],
          contextMessageKeys: []
        }
      ],
      resurfaceReasons: new Map([[emailActionResurfaceKey(signature, "msg-1"), "due_tomorrow"]])
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.suggestionMetadata.resurfaceReason).toBe("due_tomorrow");
  });

  it("resurfaces relevant context only when the monitor supplies a boolean match", () => {
    const signature = createEmailActionSubjectSignature("Budget approval");
    const planned = plan([item({ messageKey: "new-message" })], "suggest", [], {
      suppressionStates: [
        {
          subjectSignature: signature,
          dismissalCount: 2,
          lastDeadlineEvidenceKey: "deadline:2026-07-10T00:00:00.000Z",
          lastContextMessageKey: null,
          deadlineEvidenceKeys: ["deadline:2026-07-10T00:00:00.000Z"],
          contextMessageKeys: []
        }
      ],
      resurfaceReasons: new Map([
        [emailActionResurfaceKey(signature, "new-message"), "relevant_context"]
      ])
    });
    expect(planned[0]?.suggestionMetadata.resurfaceReason).toBe("relevant_context");
  });
});

it("accept clears the subject dismissal count and used evidence keys", () => {
  expect(
    resetAcceptedSuppression({
      dismissal_count: 2,
      last_deadline_evidence_key: "deadline:tomorrow",
      last_context_message_key: "acct-1:message-1"
    })
  ).toEqual({
    dismissal_count: 0,
    last_deadline_evidence_key: null,
    last_context_message_key: null
  });
});

describe("runEmailMonitor — relevance evidence", () => {
  it("counts a cached IMAP candidate without a source link", async () => {
    const created: string[] = [];
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({
          items: [
            item({
              account: { connectorAccountId: "acct-1", providerId: "imap", providerLabel: "IMAP" },
              sourceHref: null
            })
          ],
          accounts: [],
          gaps: []
        })
      },
      taskPort: {
        create: async (_db, input) => {
          created.push(input.title);
          return { id: "task" };
        }
      },
      preferencesRepository: { get: async () => null, upsert: async () => undefined },
      now: () => new Date(NOW)
    };

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 1,
      created: 1
    });
    expect(created).toHaveLength(1);
  });

  it("resurfaces once for new due-tomorrow evidence", async () => {
    const signature = createEmailActionSubjectSignature("Budget approval");
    const suppression: EmailActionSuppressionSnapshot = {
      subjectSignature: signature,
      dismissalCount: 2,
      lastDeadlineEvidenceKey: null,
      lastContextMessageKey: null,
      deadlineEvidenceKeys: [],
      contextMessageKeys: []
    };
    let lastDeadlineEvidenceKey = suppression.lastDeadlineEvidenceKey;
    const deadlineEvidenceKeys: string[] = [];
    const preferences: MonitorPreferencesPort = {
      get: async () => null,
      upsert: async () => undefined
    };
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({
          items: [
            item({
              dueDate: "2026-07-05T12:00:00.000Z",
              suggestedTasks: [{ title: "Approve Q3 budget", dueDate: null }]
            })
          ],
          accounts: [],
          gaps: []
        })
      },
      taskPort: { create: async () => ({ id: "task" }) },
      preferencesRepository: preferences,
      suppressionRepository: {
        list: async () => [{ ...suppression, lastDeadlineEvidenceKey, deadlineEvidenceKeys }],
        recordContextEvidence: async () => undefined,
        recordDeadlineEvidence: async (_db, _signature, key) => {
          lastDeadlineEvidenceKey = key;
          deadlineEvidenceKeys.push(key);
        }
      },
      actionRowRelevance: {
        hasRelevantContext: async () => {
          throw new Error("must not query context when deadline evidence is unused");
        }
      },
      actorUserId: "user-1",
      now: () => new Date(NOW)
    };

    expect(await runEmailMonitor(DB, "acct-1", deps)).toMatchObject({ planned: 1 });
    expect(lastDeadlineEvidenceKey).toBe("deadline:2026-07-05T12:00:00.000Z");
    expect(await runEmailMonitor(DB, "acct-1", deps)).toMatchObject({ planned: 0 });
  });

  it("evaluates relevance only for a new message and fails closed", async () => {
    const suppression: EmailActionSuppressionSnapshot = {
      subjectSignature: createEmailActionSubjectSignature("Budget approval"),
      dismissalCount: 2,
      lastDeadlineEvidenceKey: "deadline:2026-07-01T00:00:00.000Z",
      lastContextMessageKey: null,
      deadlineEvidenceKeys: ["deadline:2026-07-01T00:00:00.000Z"],
      contextMessageKeys: []
    };
    let relevanceCalls = 0;
    let lastContextKey: string | null = null;
    const contextMessageKeys: string[] = [];
    const preferences: MonitorPreferencesPort = {
      get: async () => null,
      upsert: async () => undefined
    };
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({ items: [item()], accounts: [], gaps: [] })
      },
      taskPort: { create: async () => ({ id: "task" }) },
      preferencesRepository: preferences,
      suppressionRepository: {
        list: async () => [
          { ...suppression, lastContextMessageKey: lastContextKey, contextMessageKeys }
        ],
        recordContextEvidence: async (_db, _signature, key) => {
          lastContextKey = key;
          contextMessageKeys.push(key);
        },
        recordDeadlineEvidence: async () => undefined
      },
      actionRowRelevance: {
        hasRelevantContext: async () => {
          relevanceCalls += 1;
          throw new Error("retrieval unavailable");
        }
      },
      actorUserId: "user-1",
      now: () => new Date(NOW)
    };

    expect(await runEmailMonitor(DB, "acct-1", deps)).toMatchObject({ planned: 0 });
    expect(relevanceCalls).toBe(1);
    expect(lastContextKey).toBe("acct-1:msg-1");
    expect(await runEmailMonitor(DB, "acct-1", deps)).toMatchObject({ planned: 0 });
    expect(relevanceCalls).toBe(1);
  });

  it("consumes matching context evidence only after a task is created", async () => {
    const suppression: EmailActionSuppressionSnapshot = {
      subjectSignature: createEmailActionSubjectSignature("Budget approval"),
      dismissalCount: 2,
      lastDeadlineEvidenceKey: "deadline:2026-07-01T00:00:00.000Z",
      lastContextMessageKey: null,
      deadlineEvidenceKeys: ["deadline:2026-07-01T00:00:00.000Z"],
      contextMessageKeys: []
    };
    let lastContextKey: string | null = null;
    const contextMessageKeys: string[] = [];
    let createCalls = 0;
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({ items: [item()], accounts: [], gaps: [] })
      },
      taskPort: {
        create: async () => {
          createCalls += 1;
          if (createCalls === 1) throw new Error("task store unavailable");
          return { id: "task" };
        }
      },
      preferencesRepository: { get: async () => null, upsert: async () => undefined },
      suppressionRepository: {
        list: async () => [
          { ...suppression, lastContextMessageKey: lastContextKey, contextMessageKeys }
        ],
        recordContextEvidence: async (_db, _signature, key) => {
          lastContextKey = key;
          contextMessageKeys.push(key);
        },
        recordDeadlineEvidence: async () => undefined
      },
      actionRowRelevance: { hasRelevantContext: async () => true },
      actorUserId: "user-1",
      now: () => new Date(NOW)
    };

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 1,
      created: 0
    });
    expect(lastContextKey).toBeNull();

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 1,
      created: 1
    });
    expect(lastContextKey).toBe("acct-1:msg-1");

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 0,
      created: 0
    });
  });

  it("records a rejected task write as a failure instead of dropping it silently", async () => {
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({ items: [item()], accounts: [], gaps: [] })
      },
      taskPort: {
        create: async () => {
          throw new Error("task store unavailable");
        }
      },
      preferencesRepository: { get: async () => null, upsert: async () => undefined },
      now: () => new Date(NOW)
    };

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 1,
      created: 0,
      taskFailures: 1
    });
  });
});

describe("planEmailTasks — status by mode", () => {
  it("auto_safe promotes only confident needs_action with a hard due date", () => {
    const planned = plan(
      [
        item({ dueDate: "2026-07-06T00:00:00.000Z", confidence: 0.8 }),
        item({ messageKey: "msg-2", dueDate: null, confidence: 0.9 }),
        item({ messageKey: "msg-3", dueDate: "2026-07-06T00:00:00.000Z", confidence: 0.6 })
      ],
      "auto_safe"
    );
    expect(planned.map((t) => [t.sourceRef, t.status])).toEqual([
      [emailSourceRef("acct-1", "msg-1"), "todo"],
      [emailSourceRef("acct-1", "msg-2"), "suggested"],
      [emailSourceRef("acct-1", "msg-3"), "suggested"]
    ]);
  });

  it("needs_reply is always suggested, even in auto mode", () => {
    const planned = plan(
      [
        item({
          actionability: "needs_reply",
          confidence: 0.95,
          dueDate: "2026-07-05T00:00:00.000Z",
          suggestedTasks: [{ title: "Reply to boss", dueDate: null }]
        })
      ],
      "auto"
    );
    expect(planned[0]?.status).toBe("suggested");
  });

  it("auto promotes needs_action at confidence >= 0.6 and stages the rest", () => {
    const planned = plan(
      [item({ confidence: 0.65 }), item({ messageKey: "msg-2", confidence: 0.5 })],
      "auto"
    );
    expect(planned.map((t) => t.status)).toEqual(["todo", "suggested"]);
  });
});

describe("planEmailTasks — output shape", () => {
  it("prioritizes due-within-48h and high importance at 2, else 3", () => {
    const planned = plan(
      [
        item({ suggestedTasks: [{ title: "Soon", dueDate: "2026-07-05T00:00:00.000Z" }] }),
        item({
          messageKey: "msg-2",
          importance: "high",
          suggestedTasks: [{ title: "Important", dueDate: null }]
        }),
        item({
          messageKey: "msg-3",
          suggestedTasks: [{ title: "Later", dueDate: "2026-07-20T00:00:00.000Z" }]
        })
      ],
      "suggest"
    );
    expect(planned.map((t) => t.priority)).toEqual([2, 2, 3]);
  });

  it("uses the candidate due date, falling back to the item due date", () => {
    const planned = plan(
      [
        item({
          dueDate: "2026-07-08T00:00:00.000Z",
          suggestedTasks: [
            { title: "Has own due", dueDate: "2026-07-06T00:00:00.000Z" },
            { title: "Inherits", dueDate: null }
          ]
        })
      ],
      "suggest"
    );
    expect(planned.map((t) => t.dueAt)).toEqual([
      "2026-07-06T00:00:00.000Z",
      "2026-07-08T00:00:00.000Z"
    ]);
  });

  it("rejects an item with only a due date and no guarded title", () => {
    const planned = plan(
      [item({ suggestedTasks: [], dueDate: "2026-07-06T00:00:00.000Z" })],
      "suggest"
    );
    expect(planned).toEqual([]);
  });

  it("bounds the description at 600 chars and never emits a planted body", () => {
    const body = "FULL PRIVATE BODY ".repeat(60);
    const longReason = "r".repeat(700);
    const planted = item({ reason: longReason }) as EmailContextItem & { body: string };
    const withBody = { ...planted, body };
    const planned = plan([withBody], "suggest");
    expect(planned[0]?.description?.length).toBe(600);
    expect(planned[0]?.description).not.toBe(body);
    expect(planned[0]?.description?.includes("FULL PRIVATE BODY")).toBe(false);
  });

  it("uses fixed authored copy when there is no guarded reason", () => {
    const planned = plan([item({ reason: null })], "suggest");
    expect(planned[0]?.description).toBe("This email may need your attention.");
    expect(planned[0]?.description).not.toBe(item().summary);
  });
});

describe("runEmailMonitor — suppression read failures and message-scoped evidence", () => {
  it("preserves actionable candidates and persists degraded status when suppression read fails", async () => {
    const prefs = new Map<string, unknown>();
    let createCalls = 0;
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({ items: [item()], accounts: [], gaps: [] })
      },
      taskPort: {
        create: async () => {
          createCalls += 1;
          return { id: "unexpected" };
        }
      },
      preferencesRepository: {
        get: async () => null,
        upsert: async (_db, key, value) => {
          prefs.set(key, value);
        }
      },
      suppressionRepository: {
        list: async () => {
          throw new Error("private subject content");
        },
        recordContextEvidence: async () => undefined,
        recordDeadlineEvidence: async () => undefined
      },
      now: () => new Date(NOW)
    };

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toEqual({
      planned: 1,
      created: 1,
      degraded: true,
      taskFailures: 0
    });
    expect(createCalls).toBe(1);
    expect(prefs.get(MONITOR_STATUS_PREF_KEY("acct-1"))).toMatchObject({
      status: "degraded",
      planned: 1,
      created: 1
    });
  });

  it("resurfaces only the due message when same-subject siblings share a signature", async () => {
    let lastDeadlineEvidenceKey: string | null = null;
    const deadlineEvidenceKeys: string[] = [];
    const createdTitles: string[] = [];
    const suppression: EmailActionSuppressionSnapshot = {
      subjectSignature: createEmailActionSubjectSignature("Budget approval"),
      dismissalCount: 2,
      lastDeadlineEvidenceKey: null,
      lastContextMessageKey: null,
      deadlineEvidenceKeys: [],
      contextMessageKeys: []
    };
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({
          items: [
            item({
              messageKey: "due-message",
              dueDate: "2026-07-05T12:00:00.000Z",
              suggestedTasks: [{ title: "Approve due budget", dueDate: null }]
            }),
            item({
              messageKey: "no-due-message",
              suggestedTasks: [{ title: "Review related budget", dueDate: null }]
            })
          ],
          accounts: [],
          gaps: []
        })
      },
      taskPort: {
        create: async (_db, input) => {
          createdTitles.push(input.title);
          return { id: input.externalKey };
        }
      },
      preferencesRepository: { get: async () => null, upsert: async () => undefined },
      suppressionRepository: {
        list: async () => [{ ...suppression, lastDeadlineEvidenceKey, deadlineEvidenceKeys }],
        recordContextEvidence: async () => undefined,
        recordDeadlineEvidence: async (_db, _signature, key) => {
          lastDeadlineEvidenceKey = key;
          deadlineEvidenceKeys.push(key);
        }
      },
      now: () => new Date(NOW)
    };

    expect(await runEmailMonitor(DB, "acct-1", deps)).toMatchObject({ planned: 1, created: 1 });
    expect(createdTitles).toEqual(["Approve due budget"]);
    expect(lastDeadlineEvidenceKey).toBe("deadline:2026-07-05T12:00:00.000Z");
    createdTitles.length = 0;

    expect(await runEmailMonitor(DB, "acct-1", deps)).toMatchObject({ planned: 0, created: 0 });
    expect(createdTitles).toEqual([]);
  });

  it("consumes the deadline trigger once across multiple child task dates", async () => {
    const signature = createEmailActionSubjectSignature("Budget approval");
    const deadlineEvidenceKeys: string[] = [];
    const createdTitles: string[] = [];
    const suppression: EmailActionSuppressionSnapshot = {
      subjectSignature: signature,
      dismissalCount: 2,
      lastDeadlineEvidenceKey: null,
      lastContextMessageKey: null,
      deadlineEvidenceKeys,
      contextMessageKeys: []
    };
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({
          items: [
            item({
              suggestedTasks: [
                { title: "Approve tomorrow", dueDate: "2026-07-05T12:00:00.000Z" },
                { title: "Review later", dueDate: "2026-07-10T12:00:00.000Z" }
              ]
            })
          ],
          accounts: [],
          gaps: []
        })
      },
      taskPort: {
        create: async (_db, input) => {
          createdTitles.push(input.title);
          return { id: input.externalKey };
        }
      },
      preferencesRepository: { get: async () => null, upsert: async () => undefined },
      suppressionRepository: {
        list: async () => [suppression],
        recordContextEvidence: async () => undefined,
        recordDeadlineEvidence: async (_db, _signature, key) => {
          deadlineEvidenceKeys.push(key);
        }
      },
      now: () => new Date(NOW)
    };

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 2,
      created: 2
    });
    expect(createdTitles).toEqual(["Approve tomorrow", "Review later"]);
    expect(deadlineEvidenceKeys).toEqual(["deadline:2026-07-05T12:00:00.000Z"]);

    createdTitles.length = 0;
    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 0,
      created: 0
    });
    expect(createdTitles).toEqual([]);
    expect(deadlineEvidenceKeys).toEqual(["deadline:2026-07-05T12:00:00.000Z"]);
  });

  it("consumes each same-subject context message once across monitor runs", async () => {
    const signature = createEmailActionSubjectSignature("Budget approval");
    const contextMessageKeys: string[] = [];
    let relevanceCalls = 0;
    const suppression: EmailActionSuppressionSnapshot = {
      subjectSignature: signature,
      dismissalCount: 2,
      lastDeadlineEvidenceKey: "deadline:2026-07-01T00:00:00.000Z",
      lastContextMessageKey: null,
      deadlineEvidenceKeys: ["deadline:2026-07-01T00:00:00.000Z"],
      contextMessageKeys
    };
    const deps: RunEmailMonitorDeps = {
      savedContext: {
        listEmailContext: async () => ({
          items: [
            item({ messageKey: "context-1", source: "live", dueDate: null }),
            item({ messageKey: "context-2", source: "live", dueDate: null })
          ],
          accounts: [],
          gaps: []
        })
      },
      taskPort: { create: async () => ({ id: "task" }) },
      preferencesRepository: { get: async () => null, upsert: async () => undefined },
      suppressionRepository: {
        list: async () => [suppression],
        recordContextEvidence: async (_db, _signature, key) => {
          contextMessageKeys.push(key);
        },
        recordDeadlineEvidence: async () => undefined
      },
      actionRowRelevance: {
        hasRelevantContext: async () => {
          relevanceCalls += 1;
          return true;
        }
      },
      actorUserId: "user-1",
      now: () => new Date(NOW)
    };

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 2,
      created: 2
    });
    expect(relevanceCalls).toBe(2);
    expect(contextMessageKeys).toEqual(["acct-1:context-1", "acct-1:context-2"]);

    await expect(runEmailMonitor(DB, "acct-1", deps)).resolves.toMatchObject({
      planned: 0,
      created: 0
    });
    expect(relevanceCalls).toBe(2);
    expect(contextMessageKeys).toEqual(["acct-1:context-1", "acct-1:context-2"]);
  });
});
