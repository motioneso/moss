/**
 * #2770 regression: real mail goes through the real sorter, the real email read tool and the
 * real evening composer. Only the model's answers are faked. No test seeds a hand-written
 * triage label, because the sorter no longer produces the old action labels.
 */
import { describe, expect, it, vi } from "vitest";

import type { GenerateChatInput } from "@moss/ai";
import type { ToolExecute } from "@moss/module-sdk";

import type { ComposeDeps, ComposeResult } from "../../packages/briefings/src/compose.js";
import { composeEveningBriefing } from "../../packages/briefings/src/compose-evening.js";
import type { ConnectorAccountSafeRow } from "../../packages/connectors/src/repository.js";
import type {
  EmailReadProvider,
  MailMessageKey
} from "../../packages/connectors/src/email-read-provider.js";
import type { ParsedEmail } from "../../packages/connectors/src/email-extract.js";
import {
  listEmailContext,
  type EmailSourceContextDeps
} from "../../packages/connectors/src/source-context/email.js";
import { emailListVisibleMessagesExecute } from "../../packages/email/src/tools.js";
import {
  FIXED_NOW,
  definition,
  fakeScopedDb,
  makeFakeDeps,
  runInput
} from "./briefings-compose.harness.js";

const CONTRACT_MAIL: ParsedEmail = {
  externalId: "gm-contract",
  threadId: "th-contract",
  historyId: null,
  subject: "Contract redlines for Thursday",
  from: "Dana Lee <dana@acme.example>",
  recipients: ["ben@example.com"],
  receivedAt: "2026-06-13T07:40:00.000Z",
  labelIds: ["INBOX"],
  snippet: "Hi Ben, could you look over the redlines",
  body:
    "Hi Ben,\n\nCould you look over the attached redlines and let me know by Thursday " +
    "whether the indemnity change works for you? Happy to jump on a call.\n\nThanks,\nDana",
  bodyTruncated: false,
  hasListUnsubscribe: false
};

const NEWSLETTER_MAIL: ParsedEmail = {
  externalId: "gm-newsletter",
  threadId: "th-newsletter",
  historyId: null,
  subject: "This week in gardening",
  from: "Garden Weekly <news@garden.example>",
  recipients: ["ben@example.com"],
  receivedAt: "2026-06-13T06:10:00.000Z",
  labelIds: ["INBOX"],
  snippet: "Tomatoes, trellises and the June planting guide",
  body:
    "Tomatoes, trellises and the June planting guide. Read the full issue online. " +
    "Unsubscribe any time from the footer of this newsletter.",
  bodyTruncated: false,
  hasListUnsubscribe: true
};

function gmailAccount(): ConnectorAccountSafeRow {
  return {
    id: "acc-google",
    provider_id: "google",
    provider_type: "google",
    provider_display_name: "Google",
    provider_status: "active",
    owner_user_id: "owner-1",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    status: "active",
    has_secret: true,
    revoked_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    last_sync_started_at: null,
    last_sync_finished_at: null,
    last_sync_status: null,
    last_sync_error: null,
    last_sync_counts: null
  } as unknown as ConnectorAccountSafeRow;
}

function fakeGmail(messages: readonly ParsedEmail[]): EmailReadProvider<string> {
  return {
    async listFolders() {
      return ["INBOX"];
    },
    async listMessageKeys() {
      return messages.map((m) => ({ folder: "INBOX", id: m.externalId }));
    },
    async getMessage(_token: string, key: MailMessageKey) {
      const found = messages.find((m) => m.externalId === key.id);
      if (!found) throw new Error("no such message");
      return found;
    }
  } as EmailReadProvider<string>;
}

/** The first-pass model answer for each message, keyed by a subject fragment in the prompt. */
function fakeSorterModel(answers: Record<string, Record<string, unknown>>) {
  return vi.fn(async (prompt: string) => {
    const match = Object.entries(answers).find(([fragment]) => prompt.includes(fragment));
    return { text: JSON.stringify(match?.[1] ?? { gate: "nothing", category: "noise" }) };
  });
}

function liveEmailDeps(
  messages: readonly ParsedEmail[],
  runChat: ReturnType<typeof fakeSorterModel>
): EmailSourceContextDeps {
  return {
    connectorsRepository: { listAccounts: async () => [gmailAccount()] },
    preferencesRepository: { get: async () => null },
    resolveGoogleCredential: async () => "token-1",
    resolveImapCredential: async () => undefined,
    googleProvider: fakeGmail(messages),
    imapProvider: fakeGmail([]) as unknown as EmailSourceContextDeps["imapProvider"],
    emailRepository: { listVisibleForBriefing: async () => [] },
    makeEmailExtractDeps: () => ({ runChat }),
    now: () => FIXED_NOW
  };
}

/** A stand-in Commitments module exposing only the public tools a test supplies. */
function commitmentsManifest(
  tools: Record<string, ToolExecute>
): ComposeDeps["moduleManifests"][number] {
  return {
    id: "commitments",
    name: "Commitments",
    version: "0.0.0",
    publisher: "test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    assistantTools: Object.entries(tools).map(([name, execute]) => ({
      name,
      description: name,
      permissionId: "commitments.view",
      risk: "read" as const,
      inputSchema: { type: "object" as const, properties: {} },
      execute
    }))
  };
}

/** Real email read tool over the real live source-context read. */
function withRealEmailPath(deps: ComposeDeps, emailDeps: EmailSourceContextDeps): ComposeDeps {
  return {
    ...deps,
    sourceContextService: {
      listEmailContext: (scopedDb, input) => listEmailContext(scopedDb, emailDeps, input),
      listCalendarContext: async () => ({ items: [], accounts: [], gaps: [] })
    },
    moduleManifests: deps.moduleManifests.map((m) => ({
      ...m,
      assistantTools: (m.assistantTools ?? []).map((t) =>
        t.name === "email.listVisibleMessages"
          ? { ...t, execute: emailListVisibleMessagesExecute as ToolExecute }
          : t
      )
    }))
  };
}

async function composeEveningWith(
  emailDeps: EmailSourceContextDeps,
  extraManifests: ComposeDeps["moduleManifests"] = []
): Promise<{ prompt: string; result: ComposeResult }> {
  const seen: string[] = [];
  const base = withRealEmailPath(
    makeFakeDeps({
      generateChat: async (input: GenerateChatInput) => {
        seen.push(input.messages.map((m) => m.content).join("\n"));
        return { text: "synth narrative" };
      }
    }),
    emailDeps
  );
  const deps: ComposeDeps = {
    ...base,
    moduleManifests: [...base.moduleManifests, ...extraManifests]
  };
  const result = await composeEveningBriefing(
    fakeScopedDb,
    definition({
      title: "Evening",
      briefing_type: "evening",
      schedule_metadata: { targetTime: "18:00", timezone: "UTC" },
      selected_tool_names: ["email.listVisibleMessages"]
    }),
    runInput,
    deps
  );
  return { prompt: seen.join("\n"), result };
}

function emailBlock(prompt: string): string {
  const match = prompt.match(
    /<external_source type="email_today">\n([\s\S]*?)\n<\/external_source>/
  );
  return match?.[1] ?? "";
}

type Gap = { source: string; reason: string };

describe("evening briefing email section over the real sorter (#2770)", () => {
  it("keeps an unlabelled email the sorter hands to the closer look", async () => {
    const runChat = fakeSorterModel({
      "Contract redlines": {
        gate: "maybe_owed",
        category: "needs_reply",
        reason: "Dana asks for an answer by Thursday.",
        confidence: 0.6
      }
    });
    const { prompt, result } = await composeEveningWith(liveEmailDeps([CONTRACT_MAIL], runChat));

    expect(runChat).toHaveBeenCalled();
    const block = emailBlock(prompt);
    expect(block).not.toBe("");
    expect(block).toContain("Contract redlines for Thursday");
    const gaps = result.sourceMetadata.gaps as Gap[];
    expect(gaps.filter((gap) => gap.source === "email_today")).toEqual([]);
  });

  it("adds a short worth-knowing line from fyi mail", async () => {
    const runChat = fakeSorterModel({
      "This week in gardening": {
        gate: "worth_knowing",
        category: "fyi",
        summary: "Garden Weekly shared the June planting guide.",
        confidence: 0.8
      }
    });
    const { prompt } = await composeEveningWith(liveEmailDeps([NEWSLETTER_MAIL], runChat));

    expect(emailBlock(prompt)).toContain("[worth knowing]");
  });

  it("records a filtered-out gap when every fetched email is left out", async () => {
    const runChat = fakeSorterModel({
      "This week in gardening": { gate: "nothing", category: "noise", confidence: 0.9 }
    });
    const { result } = await composeEveningWith(liveEmailDeps([NEWSLETTER_MAIL], runChat));

    const gaps = result.sourceMetadata.gaps as Gap[];
    expect(gaps).toContainEqual({ source: "email_today", reason: "filtered_out" });
    expect(gaps).not.toContainEqual({ source: "email_today", reason: "empty" });
  });

  it("records an empty gap when no email arrived today", async () => {
    const { result } = await composeEveningWith(liveEmailDeps([], fakeSorterModel({})));

    const gaps = result.sourceMetadata.gaps as Gap[];
    expect(gaps).toContainEqual({ source: "email_today", reason: "empty" });
  });

  it("adds pending commitment suggestions read through the Commitments tool", async () => {
    const listPending: ToolExecute = async () => ({
      data: {
        items: [
          {
            id: "cand-1",
            kind: "owed_by_me",
            title: "Send Dana the signed redlines",
            status: "pending_review",
            confidence: 0.8,
            dueLocalDate: "2026-06-18",
            counterpartyLabel: "Dana Lee",
            sourceCount: 1,
            lastSeenAt: "2026-06-13T07:45:00.000Z"
          }
        ]
      }
    });
    const { prompt } = await composeEveningWith(liveEmailDeps([], fakeSorterModel({})), [
      commitmentsManifest({ "commitments.list": listPending })
    ]);

    expect(emailBlock(prompt)).toContain("Send Dana the signed redlines");
  });

  it("leaves out closer-look mail whose thread Commitments already judged", async () => {
    const runChat = fakeSorterModel({
      "Contract redlines": { gate: "maybe_owed", category: "needs_reply", confidence: 0.6 }
    });
    const lookups: Record<string, unknown>[] = [];
    const threadJudgements: ToolExecute = async (_db, input) => {
      lookups.push(input);
      return {
        data: { threads: [{ threadRef: "th-contract", judgedAt: "2026-06-13T08:00:00.000Z" }] }
      };
    };
    const { prompt, result } = await composeEveningWith(liveEmailDeps([CONTRACT_MAIL], runChat), [
      commitmentsManifest({ "commitments.threadJudgements": threadJudgements })
    ]);

    expect(lookups).toEqual([{ threadRefs: ["th-contract"] }]);
    expect(emailBlock(prompt)).not.toContain("Contract redlines for Thursday");
    const gaps = result.sourceMetadata.gaps as Gap[];
    expect(gaps).toContainEqual({ source: "email_today", reason: "filtered_out" });
  });

  it("records a truncated gap when more mail awaits a closer look than the section shows", async () => {
    const many: ParsedEmail[] = Array.from({ length: 7 }, (_, i) => ({
      ...CONTRACT_MAIL,
      externalId: `gm-ask-${i}`,
      threadId: `th-ask-${i}`,
      subject: `Quick question number ${i}`,
      receivedAt: `2026-06-13T0${i + 1}:00:00.000Z`
    }));
    const runChat = fakeSorterModel({
      "Quick question": { gate: "maybe_owed", category: "needs_reply", confidence: 0.6 }
    });
    const { prompt, result } = await composeEveningWith(liveEmailDeps(many, runChat));

    expect(emailBlock(prompt)).toContain("Quick question");
    const gaps = result.sourceMetadata.gaps as Gap[];
    expect(gaps).toContainEqual({ source: "email_today", reason: "truncated" });
  });
});
