import { describe, expect, it, vi } from "vitest";

import type { GenerateStructuredProviderInput } from "@moss/ai";
import type { DataContextDb } from "@moss/db";

import { buildEmailExtractDeps } from "../../packages/connectors/src/extract-deps.js";
import {
  extractEmailSignalsBatch,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

const FIXTURES: readonly ParsedEmail[] = [
  {
    externalId: "synthetic-0",
    threadId: "thread-0",
    historyId: "history-0",
    subject: "Quarterly numbers requested",
    from: "alice@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:00:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Please send the Q2 numbers by Friday.",
    body: "Hi Ben, could you send the Q2 numbers by Friday afternoon? I need them for the planning review. Thanks, Alice.",
    bodyTruncated: false
  },
  {
    externalId: "synthetic-1",
    threadId: "thread-1",
    historyId: "history-1",
    subject: "Electric bill due Friday",
    from: "billing@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:01:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Your electric bill is due on Friday.",
    body: "Your electric bill of 120 dollars is due on Friday, August 7. Pay online before the late fee applies.",
    bodyTruncated: false
  },
  {
    externalId: "synthetic-2",
    threadId: "thread-2",
    historyId: "history-2",
    subject: "Flight gate changed",
    from: "airline@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:02:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Your departure gate changed to C12.",
    body: "Your flight tomorrow departs from gate C12 instead of B4. Boarding begins at 6:20 AM; no response is required.",
    bodyTruncated: false
  },
  {
    externalId: "synthetic-3",
    threadId: "thread-3",
    historyId: "history-3",
    subject: "Package delivery update",
    from: "shipping@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:03:00.000Z",
    labelIds: ["INBOX"],
    snippet: "The replacement part is expected tomorrow.",
    body: "The replacement part has shipped and should arrive tomorrow. We will send another notice after delivery.",
    bodyTruncated: false
  },
  {
    externalId: "synthetic-4",
    threadId: "thread-4",
    historyId: "history-4",
    subject: "Your appointment is confirmed",
    from: "clinic@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:04:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Your appointment is confirmed for next week.",
    body: "This confirms your appointment for next Tuesday at 10 AM. Please arrive ten minutes early.",
    bodyTruncated: false
  },
  {
    externalId: "synthetic-5",
    threadId: "thread-5",
    historyId: "history-5",
    subject: "August product newsletter",
    from: "newsletter@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:05:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Read the latest product news and offers.",
    body: "Read our August product news, customer stories, and limited-time offers. Manage preferences at any time.",
    bodyTruncated: false
  },
  {
    externalId: "synthetic-6",
    threadId: "thread-6",
    historyId: "history-6",
    subject: "Project archive notice",
    from: "archive@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:06:00.000Z",
    labelIds: ["INBOX"],
    snippet: "The project archive is available for reference.",
    body: "The project archive is available for reference. This message contains no request, deadline, or follow-up.",
    bodyTruncated: false
  }
];

const MODEL_RESULTS = [
  {
    gate: "maybe_owed",
    category: "needs_reply",
    confidence: 0.94,
    reason: "A reply is requested.",
    action: "Send Q2 numbers to Alice"
  },
  {
    gate: "maybe_owed",
    category: "needs_action",
    confidence: 0.91,
    reason: "A payment is due.",
    action: "Pay the electric bill",
    dueDate: "2026-08-07"
  },
  {
    gate: "worth_knowing",
    category: "time_sensitive_info",
    confidence: 0.88,
    reason: "The gate changed."
  },
  {
    gate: "worth_knowing",
    category: "waiting_on_someone",
    confidence: 0.82,
    reason: "A delivery is pending."
  },
  {
    gate: "worth_knowing",
    category: "fyi",
    confidence: 0.9,
    reason: "The appointment is confirmed."
  },
  { gate: "nothing", category: "noise", confidence: 0.98, reason: "This is a newsletter." },
  { gate: "worth_knowing", category: "unknown", confidence: 0.55, reason: "No action is apparent." }
] as const;

// What the first-pass gate lets each row keep (spec 2026-09-04-email-chief-of-staff §3.1):
// maybe_owed rows carry no verdict until the thread judgement runs, worth_knowing rows read as
// fyi, nothing rows read as noise.
const GATED_CATEGORIES = [undefined, undefined, "fyi", "fyi", "fyi", "noise", "fyi"];

describe("compact email extraction batch contract", () => {
  it("completes the exact seven-fixture workload with compact indexed results", async () => {
    const inputs: GenerateStructuredProviderInput[] = [];
    let outputBytes = 0;
    const generateStructured = vi.fn(async (input: GenerateStructuredProviderInput) => {
      inputs.push(input);
      const rawObject = {
        results: MODEL_RESULTS.map((value, index) => ({ index, value })).reverse()
      };
      outputBytes = Buffer.byteLength(JSON.stringify(rawObject), "utf8");
      return {
        rawObject,
        usage: { inputTokens: 1, outputTokens: 1 }
      };
    });
    const deps: EmailExtractDeps = buildEmailExtractDeps(
      {} as DataContextDb,
      {
        resolveModelForService: async () => ({
          model: {
            id: "synthetic-model",
            provider_config_id: "synthetic-provider",
            provider_kind: "anthropic",
            provider_model_id: "claude-haiku-4-5"
          }
        }),
        selectProviderWithCredential: async () => ({
          auth_method: "cli",
          provider_kind: "anthropic",
          encrypted_credential: null,
          base_url: null
        })
      } as never,
      {} as never,
      { createCliStructuredAdapter: () => ({ generateStructured }) }
    );

    const startedAt = performance.now();
    const results = await extractEmailSignalsBatch(FIXTURES, deps, { callTimeoutMs: 20_000 });
    const elapsedMs = Math.round(performance.now() - startedAt);

    expect(results).toHaveLength(7);
    expect(results.map((result) => result.signals.actionability?.category)).toEqual(
      GATED_CATEGORIES
    );
    expect(results.map((result) => result.signals.confidence)).toEqual(
      MODEL_RESULTS.map(({ confidence }) => confidence)
    );
    expect(results.map((result) => result.gate)).toEqual(MODEL_RESULTS.map(({ gate }) => gate));
    expect(results[0]?.summary).toBeNull();
    expect(results[0]?.signals.pendingJudgement).toBe(true);
    expect(results[1]?.signals.pendingJudgement).toBe(true);
    expect(results[2]?.summary).toBe(FIXTURES[2]?.snippet);
    expect(results[5]?.summary).toBeNull();
    expect(
      results.every((result) => result.signals.actionability?.suggestedTasks === undefined)
    ).toBe(true);
    expect(results.every((result) => result.signals.billsDue?.length === 0)).toBe(true);
    expect(results.every((result) => result.signals.actionItems?.length === 0)).toBe(true);
    expect(results.every((result) => result.signals.deadlines?.length === 0)).toBe(true);
    expect(results.every((result) => result.signals.importance === "normal")).toBe(true);

    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(inputs).toHaveLength(1);
    const prompt = inputs[0]?.messages[0]?.content ?? "";
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    const schemaBytes = Buffer.byteLength(JSON.stringify(inputs[0]?.schema ?? {}), "utf8");
    expect(elapsedMs).toBeLessThan(20_000);
    expect(promptBytes).toBeLessThan(48_000);
    expect(outputBytes).toBeGreaterThan(0);
    if (process.env.REPORT_COMPACT_EMAIL_METRICS === "1") {
      process.stdout.write(
        `compact-email-metrics promptBytes=${promptBytes} schemaBytes=${schemaBytes} outputBytes=${outputBytes} elapsedMs=${elapsedMs}\n`
      );
    }
    expect(prompt).not.toContain("billsDue");
    expect(prompt).not.toContain("actionItems");
    expect(prompt).not.toContain("deadlines");
    expect(prompt).not.toContain("mayGetLostInShuffle");
    expect(prompt).not.toContain("importance");
    const schemaText = JSON.stringify(inputs[0]?.schema);
    expect(schemaText).toContain('"category"');
    expect(schemaText).toContain('"confidence"');
    expect(schemaText).toContain('"action"');
    expect(schemaText).not.toContain("billsDue");
    expect(schemaText).not.toContain("actionItems");
    expect(schemaText).not.toContain("deadlines");
    expect(schemaText).not.toContain("mayGetLostInShuffle");
    expect(schemaText).not.toContain("importance");
  });
});
