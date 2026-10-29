import { describe, expect, it } from "vitest";
import {
  validateWorkMailJudgement,
  WORK_MAIL_INSTRUCTION,
  buildWorkMailPrompt
} from "../../packages/connectors/src/work-mail/judge.js";

const input = {
  message: {
    sender: "invented@example.test",
    subject: "Invented",
    receivedAt: "2026-10-26T10:00:00Z",
    threadHint: null,
    body: "x".repeat(240),
    bodyTruncated: false
  },
  preferences: ["Never write anything about HR mail"],
  senderContext: null,
  candidates: [{ index: 0, path: "Projects.md", title: "Projects", excerpt: "Invented project" }]
};
const valid = {
  decision: "note",
  target: { kind: "candidate", index: 0 },
  entry: "Review the invented project.",
  reason: "Action requested"
};
describe("work mail judgement boundary", () => {
  it.each([
    { ...valid, target: { kind: "path", path: "anywhere.md" } },
    { ...valid, target: { kind: "candidate", index: 1 } },
    { ...valid, entry: "a".repeat(601) },
    { ...valid, entry: "x".repeat(201) },
    { ...valid, path: "elsewhere.md" },
    { decision: "nothing", entry: "unexpected", reason: "No action" }
  ])("rejects invalid output", (value) => {
    expect(() => validateWorkMailJudgement(value, input)).toThrow("ai-invalid");
  });
  it("allows bounded entries and plain mail", () => {
    expect(validateWorkMailJudgement(valid, input)).toEqual(valid);
    expect(validateWorkMailJudgement({ ...valid, entry: "x".repeat(200) }, input).decision).toBe(
      "note"
    );
    expect(
      validateWorkMailJudgement({ decision: "nothing", reason: "Plain mail" }, input).decision
    ).toBe("nothing");
  });
  it("keeps instructions under 150 words, separates untrusted data, and bounds UTF-8", () => {
    expect(WORK_MAIL_INSTRUCTION.split(/\s+/).length).toBeLessThan(150);
    const prompt = buildWorkMailPrompt({
      ...input,
      message: { ...input.message, body: "😀".repeat(24000) },
      preferences: ["😀".repeat(50000)]
    });
    expect(Buffer.byteLength(prompt)).toBeLessThan(65536);
    expect(prompt).not.toContain("Projects.md");
    expect(buildWorkMailPrompt(input)).toContain(input.preferences[0]);
  });
});
