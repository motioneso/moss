/**
 * #2763 regression: real mail goes through the real sorter, the real email read tool and the
 * real morning composer. Only the model's answers are faked. No test seeds a hand-written
 * triage label, because the sorter no longer produces the old action labels.
 */
import { describe, expect, it, vi } from "vitest";

import type { GenerateChatInput } from "@moss/ai";
import type { EmailMessage } from "@moss/db";
import type { ToolExecute } from "@moss/module-sdk";

import {
  composeBriefing,
  type ComposeDeps,
  type ComposeResult
} from "../../packages/briefings/src/compose.js";
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
  runChat: ReturnType<typeof fakeSorterModel>,
  cached: readonly EmailMessage[] = []
): EmailSourceContextDeps {
  return {
    connectorsRepository: { listAccounts: async () => [gmailAccount()] },
    preferencesRepository: { get: async () => null },
    resolveGoogleCredential: async () => "token-1",
    resolveImapCredential: async () => undefined,
    googleProvider: fakeGmail(messages),
    imapProvider: fakeGmail([]) as unknown as EmailSourceContextDeps["imapProvider"],
    emailRepository: { listVisibleForBriefing: async () => [...cached] },
    makeEmailExtractDeps: () => ({ runChat }),
    now: () => FIXED_NOW
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

async function composeWith(emailDeps: EmailSourceContextDeps): Promise<{
  prompt: string;
  result: ComposeResult;
}> {
  const seen: string[] = [];
  const deps = withRealEmailPath(
    makeFakeDeps({
      generateChat: async (input: GenerateChatInput) => {
        seen.push(input.messages.map((m) => m.content).join("\n"));
        return { text: "synth narrative" };
      }
    }),
    emailDeps
  );
  const result = await composeBriefing(
    fakeScopedDb,
    definition({ selected_tool_names: ["email.listVisibleMessages"] }),
    runInput,
    deps
  );
  return { prompt: seen.join("\n"), result };
}

function emailBlock(prompt: string): string {
  const match = prompt.match(/<external_source type="email">\n([\s\S]*?)\n<\/external_source>/);
  return match?.[1] ?? "";
}

describe("morning briefing email section over the real sorter (#2763)", () => {
  it("keeps an unlabelled email the sorter hands to the closer look", async () => {
    const runChat = fakeSorterModel({
      "Contract redlines": {
        gate: "maybe_owed",
        category: "needs_reply",
        reason: "Dana asks for an answer by Thursday.",
        confidence: 0.6
      }
    });
    const { prompt, result } = await composeWith(liveEmailDeps([CONTRACT_MAIL], runChat));

    expect(runChat).toHaveBeenCalled();
    const block = emailBlock(prompt);
    expect(block).not.toBe("");
    expect(block).not.toContain("(none today)");
    expect(block).toContain("Contract redlines for Thursday");
    expect(result.sourceMetadata.emailCount).toBeGreaterThan(0);
    const gaps = result.sourceMetadata.gaps as { source: string; reason: string }[];
    expect(gaps.filter((gap) => gap.source === "email")).toEqual([]);
  });

  it("reuses the stored closer-look decision without asking the model again", async () => {
    const runChat = fakeSorterModel({});
    const stored = {
      id: "row-contract",
      connector_account_id: "acc-google",
      owner_user_id: "owner-1",
      sender: CONTRACT_MAIL.from,
      recipients: CONTRACT_MAIL.recipients,
      subject: CONTRACT_MAIL.subject,
      snippet: CONTRACT_MAIL.snippet,
      body_excerpt: null,
      received_at: new Date(CONTRACT_MAIL.receivedAt),
      external_id: CONTRACT_MAIL.externalId,
      external_metadata: { threadId: "th-contract" },
      summary: null,
      signals: { importance: "normal", confidence: 0.6, pendingJudgement: true },
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW
    } as EmailMessage;
    const { prompt } = await composeWith(liveEmailDeps([CONTRACT_MAIL], runChat, [stored]));

    expect(runChat).not.toHaveBeenCalled();
    expect(emailBlock(prompt)).toContain("Contract redlines for Thursday");
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
    const { prompt } = await composeWith(liveEmailDeps([NEWSLETTER_MAIL], runChat));

    expect(emailBlock(prompt)).toContain("[worth knowing]");
  });

  it("records a filtered-out gap when every fetched email is left out", async () => {
    const runChat = fakeSorterModel({
      "This week in gardening": { gate: "nothing", category: "noise", confidence: 0.9 }
    });
    const { result } = await composeWith(liveEmailDeps([NEWSLETTER_MAIL], runChat));

    const gaps = result.sourceMetadata.gaps as { source: string; reason: string }[];
    expect(gaps).toContainEqual({ source: "email", reason: "filtered_out" });
    expect(gaps).not.toContainEqual({ source: "email", reason: "empty" });
  });

  it("adds pending commitment suggestions read through the Commitments tool", async () => {
    const runChat = fakeSorterModel({});
    const seen: string[] = [];
    const base = withRealEmailPath(
      makeFakeDeps({
        generateChat: async (input: GenerateChatInput) => {
          seen.push(input.messages.map((m) => m.content).join("\n"));
          return { text: "synth narrative" };
        }
      }),
      liveEmailDeps([], runChat)
    );
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
    const deps: ComposeDeps = {
      ...base,
      moduleManifests: [
        ...base.moduleManifests,
        {
          id: "commitments",
          name: "Commitments",
          version: "0.0.0",
          publisher: "test",
          lifecycle: "optional",
          compatibility: { jarv1s: ">=0.0.0" },
          assistantTools: [
            {
              name: "commitments.list",
              description: "pending suggestions",
              permissionId: "commitments.view",
              risk: "read",
              inputSchema: { type: "object", properties: {} },
              execute: listPending
            }
          ]
        }
      ]
    };
    await composeBriefing(
      fakeScopedDb,
      definition({ selected_tool_names: ["email.listVisibleMessages"] }),
      runInput,
      deps
    );

    expect(emailBlock(seen.join("\n"))).toContain("Send Dana the signed redlines");
  });
});
