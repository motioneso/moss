import { describe, expect, it } from "vitest";

import { getMemoryPendingCandidatesRouteSchema } from "../../packages/shared/src/memory-dashboard-api.js";
import {
  candidateLabel,
  pendingCandidateItem
} from "../../packages/memory/src/candidate-labels.js";
import type { MemoryCandidateRecord } from "../../packages/memory/src/candidates-repository.js";
import { memoryCandidateTarget } from "../../packages/memory/src/chat-targets.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const CANDIDATE_ID = "00000000-0000-4000-8000-000000000106";
const CREATED_AT = "2026-10-06T12:00:00.000Z";

function candidate(payloadJson: Record<string, unknown>): MemoryCandidateRecord {
  return {
    id: CANDIDATE_ID,
    ownerUserId: "00000000-0000-4000-8000-000000000001",
    episodeId: "00000000-0000-4000-8000-000000000002",
    kind: "fact",
    action: "create",
    payloadJson,
    candidateSignature: "excerpt-boundaries",
    status: "pending",
    confidence: 0.8,
    importance: 0.5,
    provenance: "volunteered",
    promotionReason: null,
    createdAt: new Date(CREATED_AT),
    updatedAt: new Date(CREATED_AT),
    resolvedAt: null
  };
}

const payloadKinds = [
  { name: "summary", payload: (text: string) => ({ summary: text }) },
  { name: "manual excerpt", payload: (text: string) => ({ manualRequest: true, excerpt: text }) },
  { name: "fact", payload: (text: string) => ({ fact: { objectText: text } }) },
  { name: "entity", payload: (text: string) => ({ entity: { name: text } }) }
];

describe("pending memory candidate excerpts", () => {
  it("requires both truncation flags in the serialized item contract", () => {
    const schema = getMemoryPendingCandidatesRouteSchema.response[200].properties.items.items;
    expect(schema.required).toEqual(expect.arrayContaining(["titleTruncated", "summaryTruncated"]));
    expect(schema.properties).toMatchObject({
      titleTruncated: { type: "boolean" },
      summaryTruncated: { type: "boolean" }
    });
  });

  describe.each(payloadKinds)("$name", ({ payload }) => {
    it.each([119, 120, 121, 199, 200, 201])(
      "reports exact boundaries for %i UTF-16 units",
      (length) => {
        const text = "a".repeat(length);
        const item = pendingCandidateItem(candidate(payload(text)));
        expect(item).toMatchObject({
          id: CANDIDATE_ID,
          title: text.slice(0, 120),
          summary: text.slice(0, 200),
          titleTruncated: length > 120,
          summaryTruncated: length > 200,
          createdAt: CREATED_AT
        });
        expect(candidateLabel(payload(text))).toBe(text);
      }
    );

    it.each([
      { text: "a".repeat(118) + "😀", title: "a".repeat(118) + "😀", summaryLength: 120 },
      { text: "a".repeat(119) + "😀", title: "a".repeat(119), summaryLength: 121 },
      { text: "a".repeat(198) + "😀", title: "a".repeat(120), summaryLength: 200 },
      { text: "a".repeat(199) + "😀", title: "a".repeat(120), summaryLength: 199 },
      { text: "😀".repeat(101), title: "😀".repeat(60), summaryLength: 200 }
    ])("never splits valid surrogate pairs at either boundary: $summaryLength", (test) => {
      const item = pendingCandidateItem(candidate(payload(test.text)));
      expect(item).toMatchObject({
        title: test.title,
        summary: test.text.slice(0, test.summaryLength),
        titleTruncated: test.text.length > 120,
        summaryTruncated: test.text.length > 200
      });
      expect(item.title.length).toBeLessThanOrEqual(120);
      expect(item.summary.length).toBeLessThanOrEqual(200);
      expect(item.title).not.toMatch(/[\ud800-\udbff]$/u);
      expect(item.summary).not.toMatch(/[\ud800-\udbff]$/u);
      expect(candidateLabel(payload(test.text))).toBe(test.text);
    });
  });

  it.each([
    "fact",
    "preference",
    "goal",
    "constraint",
    "decision",
    "relationship",
    "alias",
    "inference"
  ])("preserves the supported record kind %s", (recordKind) => {
    expect(pendingCandidateItem(candidate({ summary: "short", recordKind })).recordKind).toBe(
      recordKind
    );
  });

  it.each([
    { name: "unknown 5,000-character value", value: "x".repeat(5_000) },
    { name: "unknown short value", value: "unsupported" },
    { name: "prototype name", value: "__proto__" },
    { name: "wrong case", value: "FACT" },
    { name: "empty value", value: "" },
    { name: "null value", value: null },
    { name: "numeric value", value: 1 }
  ])("omits $name instead of serializing it as recordKind", ({ value }) => {
    const item = pendingCandidateItem(candidate({ summary: "short", recordKind: value }));
    expect(item).not.toHaveProperty("recordKind");
    expect(item).toMatchObject({ titleTruncated: false, summaryTruncated: false });
  });

  it.each([
    {
      name: "manual",
      payload: { manualRequest: true, excerpt: " remembered text ".repeat(40).trim() },
      label: " remembered text ".repeat(40).trim()
    },
    {
      name: "fact",
      payload: {
        fact: { subject: "The user", predicate: "prefers", objectText: "long fact ".repeat(40) }
      },
      label: `The user prefers ${"long fact ".repeat(40)}`
    },
    {
      name: "entity",
      payload: { entity: { name: "long entity name ".repeat(40) } },
      label: "long entity name ".repeat(40)
    }
  ])("keeps the full $name label in direct-ID target resolution", async ({ payload, label }) => {
    const item = pendingCandidateItem(candidate(payload));
    expect(item.title.length).toBeLessThanOrEqual(120);
    expect(item.summary.length).toBeLessThanOrEqual(200);
    expect(candidateLabel(payload)).toBe(label);
    const { scoped, queries } = makeRecordingDb({
      rows: [{ id: CANDIDATE_ID, payload_json: payload }]
    });
    try {
      expect(await memoryCandidateTarget(scoped, { id: CANDIDATE_ID })).toBe(
        `${label} [suggestion ${CANDIDATE_ID}]`
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]?.parameters).toEqual([CANDIDATE_ID]);
      expect(queries[0]?.sql).toContain("owner_user_id = app.current_actor_user_id()");
      expect(queries[0]?.sql).toContain("status = 'pending'");
      expect(queries[0]?.sql).not.toMatch(/\blimit\b/i);
    } finally {
      await scoped.db.destroy();
    }
  });
});
