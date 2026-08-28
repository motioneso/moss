import { describe, expect, it, vi } from "vitest";
import { EmailExtractNeedsConfigurationError, EmailExtractRetryableError } from "@moss/connectors";
import { CliStructuredAdapter, type ChatEngineFactory } from "@moss/chat";
import type { StructuredTelemetry } from "@moss/ai";
import {
  EmailRepository,
  PreferencesRepository,
  featureGrantsPrefKey,
  handles,
  ids,
  runGoogleSync,
  runGoogleSyncChunk,
  seedGoogleAccount
} from "./helpers/google-sync-orchestration.js";

describe("runGoogleSync email orchestration", () => {
  it("waits through a busy CLI slot and never falls back on an unreadable reply", async () => {
    type SafeEvent = {
      readonly kind: string;
      readonly jobId: string;
      readonly batchIndex: number;
      readonly batchSize: number;
      readonly priority?: string;
      readonly elapsedMs?: number;
      readonly exit?: string;
      readonly count?: number;
    };
    type Telemetry = StructuredTelemetry;

    const runCase = async (mode: "busy" | "unreadable") => {
      const accountId = await seedGoogleAccount(handles.dataContext, [
        "https://www.googleapis.com/auth/gmail.modify"
      ]);
      const ctx = { actorUserId: ids.userA, requestId: `pgboss:cli-seam-${mode}` };
      const preferencesRepository = new PreferencesRepository();
      await handles.dataContext.withDataContext(ctx, (db) =>
        preferencesRepository.upsert(db, featureGrantsPrefKey(accountId), { email: true })
      );

      const messages = Array.from({ length: 21 }, (_, index) => ({
        id: `cli-seam-${mode}-${index}`
      }));
      const compactExtraction = {
        category: "needs_action",
        reason: "A review is required.",
        action: "Review the request",
        confidence: 0.9
      };
      const events: SafeEvent[] = [];
      let extractionCalls = 0;
      const extractionBatchSizes: number[] = [];
      let releaseHolder = false;
      let releaseLaunched!: () => void;
      const launched = new Promise<void>((resolve) => {
        releaseLaunched = resolve;
      });
      let extractionInvoked!: () => void;
      const extractionStarted = new Promise<void>((resolve) => {
        extractionInvoked = resolve;
      });
      let factoryCalls = 0;
      const engineFactory: ChatEngineFactory = () => {
        const call = factoryCalls++;
        return {
          provider: "anthropic",
          launch: vi.fn(async () => {
            if (call === 0) releaseLaunched();
            return { offset: 0 };
          }),
          submit: vi.fn(async () => undefined),
          readNew: vi.fn(async () => {
            if (mode === "busy" && call === 0 && !releaseHolder) {
              return { records: [], offset: 0, complete: false };
            }
            if (mode === "unreadable") {
              return { records: [], offset: 0, complete: false };
            }
            if (call === 0) return { records: [], offset: 0, complete: true };
            return {
              records: [
                {
                  kind: "reply" as const,
                  text: JSON.stringify(compactExtraction)
                }
              ],
              offset: 1,
              complete: true
            };
          }),
          interrupt: vi.fn(async () => undefined),
          isAlive: vi.fn(async () => !releaseHolder),
          kill: vi.fn(async () => undefined)
        };
      };
      const adapter = new CliStructuredAdapter(
        "anthropic",
        engineFactory,
        mode === "busy" ? 10_000 : 5,
        1
      );
      const inputFor = (prompt: string, telemetry?: Telemetry) =>
        ({
          model: { provider_kind: "anthropic", provider_model_id: "claude-haiku-4-5" },
          messages: [{ role: "user", content: prompt }],
          schema: { type: "object" },
          maxOutputTokens: 100,
          telemetry
        }) as Parameters<CliStructuredAdapter["generateStructured"]>[0];
      const runChat = async (
        prompt: string,
        signal?: AbortSignal,
        _batchSize?: number,
        telemetry?: Telemetry,
        priority?: "foreground" | "background"
      ) => {
        extractionCalls += 1;
        extractionBatchSizes.push(_batchSize ?? 1);
        extractionInvoked();
        const result = await adapter.generateStructured({
          ...inputFor(prompt, telemetry),
          priority
        });
        if (!("rawText" in result)) throw new Error("synthetic structured result shape");
        return { text: result.rawText };
      };
      let holder: Promise<unknown> | undefined;
      if (mode === "busy") {
        holder = adapter.generateStructured(inputFor("hold", { emit: () => undefined }));
        void holder.catch(() => undefined);
        await launched;
      }

      const projectionCalls: Array<{ sourceRef: string }> = [];
      try {
        const deps = {
          getFreshAccessToken: async () => "tok",
          getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
          googleClient: {
            listCalendarEvents: async () => [],
            listMessageIds: async () => messages,
            getMessage: async ({ id }: { id: string }) => ({
              id,
              historyId: `history-${id}`,
              internalDate: String(Date.parse("2026-08-02T16:00:00.000Z")),
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "Subject", value: "Synthetic message" },
                  { name: "From", value: "sender@example.test" }
                ],
                body: { data: Buffer.from("Synthetic body").toString("base64") }
              }
            })
          },
          emailExtractDeps: { runChat },
          emailRepository: new EmailRepository(),
          actionProjection: {
            taskPort: {
              create: async (_db: unknown, input: { sourceRef: string }) => {
                projectionCalls.push(input);
                return { id: `task-${projectionCalls.length}` };
              }
            },
            preferencesRepository,
            actorUserId: ids.userA
          },
          logger: {
            warn: () => undefined,
            info: (data: Record<string, unknown>) => {
              if (data.stage === "email-extraction") events.push(data as SafeEvent);
            }
          },
          runId: `cli-seam-${mode}`,
          now: () => new Date("2026-08-02T18:00:00.000Z")
        };
        const run = handles.workerDataContext.withDataContext(ctx, (db) =>
          runGoogleSyncChunk(db, deps)
        );
        if (mode === "busy") {
          await extractionStarted;
          releaseHolder = true;
        }
        if (mode === "busy") {
          const outcome = await run;
          expect(outcome.result).toMatchObject({ emailUpserted: 21, errors: [], truncated: true });
        } else {
          await expect(run).rejects.toBeInstanceOf(EmailExtractRetryableError);
        }
        const rows = await handles.dataContext.withDataContext(ctx, (db) =>
          db.db
            .selectFrom("app.email_messages")
            .select(["external_id", "summary", "signals"])
            .where("connector_account_id", "=", accountId)
            .execute()
        );
        const caseRows = rows.filter((row) => row.external_id.startsWith(`cli-seam-${mode}-`));
        if (mode === "busy") {
          expect(caseRows).toHaveLength(21);
          expect(caseRows.every((row) => row.summary === "Synthetic message")).toBe(true);
          expect(projectionCalls).toHaveLength(21);
          expect(
            new Set(projectionCalls.map((input) => input.sourceRef.split(":").at(-1)))
          ).toEqual(new Set(messages.map(({ id }) => id)));
          expect(extractionCalls).toBe(21);
          expect(extractionBatchSizes).toEqual(Array.from({ length: 21 }, () => 1));
        } else {
          expect(caseRows).toHaveLength(0);
          expect(projectionCalls).toHaveLength(0);
        }

        expect(events.every((event) => event.jobId === `cli-seam-${mode}`)).toBe(true);
        expect(events.every((event) => event.batchIndex === 0 && event.batchSize === 1)).toBe(true);
        expect(events.map((event) => event.kind)).toEqual(
          expect.arrayContaining(["invoked", "elapsed", "exit"])
        );
        expect(events.find((event) => event.kind === "elapsed")?.elapsedMs).toBeGreaterThanOrEqual(
          0
        );
        expect(
          events.every((event) =>
            Object.keys(event).every((key) =>
              [
                "stage",
                "jobId",
                "batchIndex",
                "batchSize",
                "priority",
                "kind",
                "elapsedMs",
                "exit",
                "count"
              ].includes(key)
            )
          )
        ).toBe(true);
        if (mode === "busy") {
          expect(events.map((event) => event.kind)).toContain("busy");
          expect(events.map((event) => event.exit)).toContain("complete");
          expect(events.every((event) => event.priority === "foreground")).toBe(true);
        } else {
          expect(events.map((event) => event.kind)).toContain("timeout");
          expect(events.map((event) => event.exit)).toContain("timeout");
        }
      } finally {
        releaseHolder = true;
        await holder?.catch(() => undefined);
      }
    };

    await runCase("busy");
    await runCase("unreadable");
  });

  it("surfaces a strict email-extract binding miss as needs-config", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:email-needs-config" };
    const warnings: string[] = [];
    const infos: string[] = [];
    const result = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => [{ id: "needs-config" }],
          getMessage: async () => ({
            id: "needs-config",
            historyId: "needs-config-history",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "Synthetic request" },
                { name: "From", value: "sender@example.test" }
              ],
              body: { data: Buffer.from("Please review this request.").toString("base64") }
            }
          })
        },
        emailExtractDeps: {
          runChat: async () => {
            throw new EmailExtractNeedsConfigurationError();
          }
        },
        logger: {
          warn: (_data, message) => warnings.push(message),
          info: (_data, message) => infos.push(message)
        }
      })
    );

    expect(result).toMatchObject({
      emailUpserted: 2,
      errors: ["email-needs-config"],
      truncated: false
    });
    expect(warnings).not.toContain("google-sync email failed");
    expect(infos).toContain("google-sync email extraction unavailable; continuing metadata-only");
  });

  it("ingests a representative current-day mailbox as sequential compact classifications", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test-google-email-fast-page" };
    const preferencesRepository = new PreferencesRepository();
    await handles.dataContext.withDataContext(ctx, (db) =>
      preferencesRepository.upsert(db, featureGrantsPrefKey(accountId), { email: true })
    );

    const messages = Array.from({ length: 48 }, (_, index) => ({ id: `today-${index}` }));
    const modelCostMs = 1_000;
    let virtualMs = 0;
    const providerReadAt: number[] = [];
    const listLimits: number[] = [];
    const classificationCompletedAt: number[] = [];
    const firstPersistAt = new Map<string, number>();
    const projectionAt: number[] = [];
    const emailRepository = new EmailRepository();
    const persist = emailRepository.upsertCachedMessage.bind(emailRepository);
    vi.spyOn(emailRepository, "upsertCachedMessage").mockImplementation(async (db, input) => {
      const saved = await persist(db, input);
      if (!firstPersistAt.has(input.externalId)) firstPersistAt.set(input.externalId, virtualMs);
      return saved;
    });
    const runChat = vi.fn(async (_prompt: string, _signal?: AbortSignal, batchSize = 1) => {
      expect(batchSize).toBe(1);
      virtualMs += modelCostMs;
      classificationCompletedAt.push(virtualMs);
      return {
        text: JSON.stringify({
          category: "needs_action",
          confidence: 0.95,
          reason: "The sender requested approval.",
          action: "Approve the request"
        })
      };
    });

    await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSyncChunk(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async () => messages,
          listMessageIdsPage: async ({ pageToken, maxResults = 100 }) => {
            listLimits.push(maxResults);
            const start = pageToken ? Number(pageToken) : 0;
            const end = Math.min(start + maxResults, messages.length);
            return {
              messages: messages.slice(start, end),
              ...(end < messages.length ? { nextPageToken: String(end) } : {})
            };
          },
          getMessage: async ({ id }) => {
            providerReadAt.push(virtualMs);
            return {
              id,
              historyId: `history-${id}`,
              internalDate: String(Date.parse("2026-08-02T16:00:00.000Z")),
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "Subject", value: "Approval needed" },
                  { name: "From", value: "sender@example.test" }
                ],
                body: { data: Buffer.from("Please approve this today.").toString("base64") }
              }
            };
          }
        },
        emailExtractDeps: {
          runChat
        },
        emailRepository,
        actionProjection: {
          taskPort: {
            create: async () => {
              projectionAt.push(virtualMs);
              return { id: `task-${projectionAt.length}` };
            }
          },
          preferencesRepository,
          actorUserId: ids.userA
        },
        now: () => new Date("2026-08-02T18:00:00.000Z")
      })
    );

    expect({
      requestedListLimit: listLimits[0],
      providerFetched: providerReadAt.length,
      providerFetchBoundaryMs: Math.max(...providerReadAt),
      persisted: firstPersistAt.size,
      persistBoundaryMs: Math.max(...firstPersistAt.values()),
      modelCalls: runChat.mock.calls.length,
      classificationBoundaryMs: Math.max(...classificationCompletedAt),
      firstProjectionAt: projectionAt[0] ?? null,
      projected: projectionAt.length
    }).toEqual({
      requestedListLimit: 500,
      providerFetched: messages.length,
      providerFetchBoundaryMs: 0,
      persisted: messages.length,
      persistBoundaryMs: 0,
      modelCalls: messages.length,
      classificationBoundaryMs: messages.length * modelCostMs,
      firstProjectionAt: modelCostMs,
      projected: messages.length
    });
  });

  it("evaluates nine recent messages as sequential 8+1 continuation chunks", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test-google-email-continuation" };
    const pages = {
      first: Array.from({ length: 8 }, (_, index) => ({ id: `bounded-${index}` })),
      second: [{ id: "bounded-8" }]
    };
    let activeExtractions = 0;
    let maxActiveExtractions = 0;
    const listMessageIdsPage = vi.fn(
      async ({ query, pageToken }: { query?: string; pageToken?: string }) => {
        if (query?.includes("older_than:1d")) return { messages: [] };
        return pageToken === "MAIL_PAGE_2"
          ? { messages: pages.second }
          : { messages: pages.first, nextPageToken: "MAIL_PAGE_2" };
      }
    );
    const deps = {
      getFreshAccessToken: async () => "tok",
      getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
      googleClient: {
        listCalendarEvents: async () => [],
        listMessageIds: async () => [...pages.first, ...pages.second],
        listMessageIdsPage,
        getMessage: async ({ id }: { id: string }) => ({
          id,
          historyId: `history-${id}`,
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: id },
              { name: "From", value: "sender@example.test" }
            ],
            body: { data: Buffer.from("Please review this.").toString("base64") }
          }
        })
      },
      emailExtractDeps: {
        runChat: async (_prompt: string, _signal?: AbortSignal, batchSize?: number) => {
          activeExtractions += 1;
          maxActiveExtractions = Math.max(maxActiveExtractions, activeExtractions);
          await Promise.resolve();
          activeExtractions -= 1;
          const value = {
            category: "fyi",
            confidence: 0.9,
            reason: "Informational update."
          };
          return {
            text: JSON.stringify(
              batchSize && batchSize > 1
                ? {
                    results: Array.from({ length: batchSize }, (_, index) => ({ index, value }))
                  }
                : value
            )
          };
        }
      }
    };

    const first = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSyncChunk(scopedDb, deps)
    );
    expect(first.result.emailUpserted).toBe(8);
    expect(first.continuation).toMatchObject({
      phase: "email-current-day",
      cursor: "MAIL_PAGE_2"
    });

    const second = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSyncChunk(scopedDb, deps, first.continuation)
    );
    expect(second.result.emailUpserted).toBe(9);
    expect(second.continuation).toMatchObject({ phase: "email", cursor: undefined });
    const third = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSyncChunk(scopedDb, deps, second.continuation)
    );
    expect(third.continuation).toBeUndefined();
    expect(listMessageIdsPage).toHaveBeenCalledTimes(3);
    expect(maxActiveExtractions).toBe(1);
  });

  it("processes every message returned by Gmail", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test-uncapped-google-email" };
    const messages = Array.from({ length: 51 }, (_, index) => ({ id: `uncapped-${index}` }));

    const result = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async ({ query }) => (query?.includes("older_than:1d") ? [] : messages),
          getMessage: async ({ id }) => ({
            id,
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: id },
                { name: "From", value: "sender@example.com" }
              ],
              body: { data: Buffer.from("body").toString("base64") }
            }
          })
        },
        emailExtractDeps: {
          runChat: async (_prompt, _signal, batchSize = 1) => ({
            text: JSON.stringify(
              batchSize === 1
                ? { summary: "Processed", confidence: 0.5 }
                : {
                    results: Array.from({ length: batchSize }, (_, index) => ({
                      index,
                      value: { summary: "Processed", confidence: 0.5 }
                    }))
                  }
            )
          })
        }
      })
    );

    expect(result.emailUpserted).toBe(51);
    expect(result.truncated).toBe(false);
  });

  it("skips email sync when the account email grant is off", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.dataContext.withDataContext(ctx, (db) =>
      new PreferencesRepository().upsert(db, featureGrantsPrefKey(accountId), {
        email: false,
        calendar: true
      })
    );

    let calendarCalls = 0;
    let emailCalls = 0;
    const result = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar", "gmail"] }),
        googleClient: {
          listCalendarEvents: async () => {
            calendarCalls += 1;
            return [];
          },
          listMessageIds: async () => {
            emailCalls += 1;
            return [];
          },
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    await handles.dataContext.withDataContext(ctx, (db) =>
      new PreferencesRepository().upsert(db, featureGrantsPrefKey(accountId), {
        email: true,
        calendar: true
      })
    );

    expect(calendarCalls).toBe(1);
    expect(emailCalls).toBe(0);
    expect(result.calendarUpserted).toBe(0);
    expect(result.emailUpserted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("skips the LLM pass for a message whose historyId is unchanged since last sync", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    let llmCalls = 0;
    const client = {
      listCalendarEvents: async () => [],
      listMessageIds: async ({ query }: { query?: string }) =>
        query?.includes("older_than:1d") ? [] : [{ id: "hist-1" }],
      getMessage: async () => ({
        id: "hist-1",
        threadId: "thread-1",
        historyId: "H100",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "S" },
            { name: "From", value: "a@b.com" }
          ],
          body: { data: Buffer.from("hi").toString("base64") }
        }
      })
    };
    const extractDeps = {
      runChat: async () => {
        llmCalls += 1;
        return {
          text: JSON.stringify({
            summary: "ok",
            confidence: 0.9,
            actionability: { category: "fyi", reason: "Informational." }
          })
        };
      }
    };
    const run = () =>
      handles.workerDataContext.withDataContext(ctx, (db) =>
        runGoogleSync(db, {
          getFreshAccessToken: async () => "tok",
          getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
          googleClient: client,
          emailExtractDeps: extractDeps,
          now: () => new Date("2026-06-13T12:00:00.000Z")
        })
      );
    await run(); // first sync: summarizes once, stores historyId H100 + a non-null summary
    await run(); // second sync: historyId unchanged AND summary present → skip the LLM pass
    expect(llmCalls).toBe(1);

    const cached = await handles.dataContext.withDataContext(ctx, (db) =>
      new EmailRepository().getByConnectorAccountAndExternalId(db, accountId, "hist-1")
    );
    expect(cached?.external_metadata).toMatchObject({ threadId: "thread-1" });
  });

  it("re-summarizes an unchanged message that was first cached with NO summary", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    const client = {
      listCalendarEvents: async () => [],
      listMessageIds: async ({ query }: { query?: string }) =>
        query?.includes("older_than:1d") ? [] : [{ id: "hist-2" }],
      getMessage: async () => ({
        id: "hist-2",
        historyId: "H200",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "S" },
            { name: "From", value: "a@b.com" }
          ],
          body: { data: Buffer.from("hi").toString("base64") }
        }
      })
    };
    // First sync: NO model configured → summary stays null, historyId H200 stored.
    await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: client,
        emailExtractDeps: {
          runChat: async () => {
            throw new EmailExtractNeedsConfigurationError();
          }
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    let llmCalls = 0;
    // Second sync: SAME historyId, but a model now exists and the prior summary is null →
    // must NOT skip; it summarizes this time.
    const result = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: client,
        emailExtractDeps: {
          runChat: async () => {
            llmCalls += 1;
            return { text: JSON.stringify({ summary: "now summarized", confidence: 0.8 }) };
          }
        },
        now: () => new Date("2026-06-13T13:00:00.000Z")
      })
    );
    expect(llmCalls).toBe(1);
    expect(result.emailUpserted).toBe(1);
  });

  it("retries a changed history revision without writing fallback triage", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:changed-revision-retry" };
    let historyId = "H1";
    let extraction = 0;
    const deps = {
      getFreshAccessToken: async () => "tok",
      getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
      googleClient: {
        listCalendarEvents: async () => [],
        listMessageIds: async ({ query }: { query?: string }) =>
          query?.includes("older_than:1d") ? [] : [{ id: "changed-revision" }],
        getMessage: async () => ({
          id: "changed-revision",
          historyId,
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "Changed request" },
              { name: "From", value: "sender@example.test" }
            ],
            body: { data: Buffer.from("Please review the changed request.").toString("base64") }
          }
        })
      },
      emailExtractDeps: {
        runChat: async () => {
          extraction += 1;
          if (extraction === 2) throw new Error("synthetic-structured-failure");
          return {
            text: JSON.stringify({
              summary: `Complete ${historyId}`,
              confidence: 0.9,
              actionability: { category: "fyi", reason: "Informational update." }
            })
          };
        }
      },
      now: () => new Date("2026-08-02T18:00:00.000Z")
    };

    await handles.workerDataContext.withDataContext(ctx, (db) => runGoogleSync(db, deps));
    historyId = "H2";
    await expect(
      handles.workerDataContext.withDataContext(ctx, (db) => runGoogleSync(db, deps))
    ).rejects.toBeInstanceOf(EmailExtractRetryableError);
    const incomplete = await handles.dataContext.withDataContext(ctx, (db) =>
      new EmailRepository().getByConnectorAccountAndExternalId(db, accountId, "changed-revision")
    );
    expect(incomplete).toMatchObject({
      summary: "Complete H1",
      external_metadata: { historyId: "H1" }
    });

    await handles.workerDataContext.withDataContext(ctx, (db) => runGoogleSync(db, deps));
    const recovered = await handles.dataContext.withDataContext(ctx, (db) =>
      new EmailRepository().getByConnectorAccountAndExternalId(db, accountId, "changed-revision")
    );
    expect(extraction).toBe(3);
    expect(recovered).toMatchObject({ summary: "Complete H2" });
  });

  it("does not let a concurrent fallback overwrite complete triage for the same message", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const emailRepository = new EmailRepository();
    const base = {
      connectorAccountId: accountId,
      externalId: "duplicate-message",
      sender: "sender@example.test",
      recipients: [],
      subject: "Synthetic reservation",
      receivedAt: "2026-08-02T18:00:00.000Z",
      externalMetadata: { historyId: "same-history" }
    };
    await handles.dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed:duplicate-triage" },
      (db) =>
        emailRepository.createCachedMessageForTest(db, {
          ...base,
          summary: null,
          signals: { confidence: 0 }
        })
    );

    let releaseFallbackRead!: () => void;
    const fallbackRead = new Promise<void>((resolve) => {
      releaseFallbackRead = resolve;
    });
    let releaseValidCommit!: () => void;
    const validCommitted = new Promise<void>((resolve) => {
      releaseValidCommit = resolve;
    });

    await Promise.all([
      handles.workerDataContext
        .withDataContext(
          { actorUserId: ids.userA, requestId: "pgboss:duplicate-valid" },
          async (db) => {
            await fallbackRead;
            return emailRepository.upsertCachedMessage(db, {
              ...base,
              summary: "A reservation needs confirmation.",
              signals: {
                confidence: 0.95,
                actionability: {
                  category: "needs_reply",
                  reason: "Confirmation was requested.",
                  inferredSubject: "Reservation confirmation",
                  suggestedTasks: [{ text: "Confirm the reservation" }]
                }
              }
            });
          }
        )
        .then((result) => {
          releaseValidCommit();
          return result;
        }),
      handles.workerDataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "pgboss:duplicate-fallback" },
        async (db) => {
          const staleMarker = (await emailRepository.listSyncMarkers(db, accountId)).find(
            (marker) => marker.externalId === base.externalId
          );
          expect(staleMarker?.hasCompleteTriage).toBe(false);
          releaseFallbackRead();
          await validCommitted;
          return emailRepository.upsertCachedMessage(db, {
            ...base,
            summary: null,
            signals: { confidence: 0 }
          });
        }
      )
    ]);

    const saved = await handles.dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "assert:duplicate-triage" },
      (db) => emailRepository.getByConnectorAccountAndExternalId(db, accountId, "duplicate-message")
    );
    expect(saved).toMatchObject({
      summary: "A reservation needs confirmation.",
      signals: {
        confidence: 0.95,
        actionability: {
          category: "needs_reply",
          inferredSubject: "Reservation confirmation"
        }
      }
    });
  });

  it("NEVER persists the full email body in any email_messages column (privacy posture)", async () => {
    // A full body LONGER than MAX_SUMMARY_CHARS (600). The fake model deliberately MISBEHAVES
    // and returns the ENTIRE body as the summary — the worst case. The persisted summary must
    // still be truncated below the cap, so the verbatim full body can never round-trip into a
    // column. (A model legitimately quoting a phrase is acceptable; persisting the whole body
    // verbatim is the invariant we defend.)
    const FULL_BODY = "SENTINEL-FULL-BODY-MUST-NOT-PERSIST-" + "x".repeat(900); // > 600 chars
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [],
          listMessageIds: async ({ query }) =>
            query?.includes("older_than:1d") ? [] : [{ id: "sentinel-1" }],
          getMessage: async () => ({
            id: "sentinel-1",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "S" },
                { name: "From", value: "a@b.com" }
              ],
              body: { data: Buffer.from(FULL_BODY).toString("base64") }
            }
          })
        },
        // Misbehaving model: echoes the WHOLE body back as the summary.
        emailExtractDeps: {
          runChat: async () => ({ text: JSON.stringify({ summary: FULL_BODY, confidence: 0.9 }) })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    const row = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.email_messages")
        .selectAll()
        .where("external_id", "=", "sentinel-1")
        .executeTakeFirstOrThrow()
    );
    // The verbatim FULL body must not appear in ANY column (subject/snippet/body_excerpt/
    // summary/signals/external_metadata, all serialized).
    expect(JSON.stringify(row)).not.toContain(FULL_BODY);
    // The summary, if present, is hard-capped at MAX_SUMMARY_CHARS so it cannot be the full body.
    const summary = (row as { summary: string | null }).summary;
    expect((summary ?? "").length).toBeLessThanOrEqual(600);
    // body_excerpt is explicitly NOT written by sync (handler never passes it).
    expect((row as { body_excerpt: string | null }).body_excerpt).toBeNull();
  });
});
