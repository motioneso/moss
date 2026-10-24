import { describe, it, expect } from "vitest";
import { normalizeMeetingVocabulary, meetingTranscriptionOptions } from "@moss/shared";
describe("bounded Meeting vocabulary", () => {
  it("normalizes only whitespace, blank entries and exact duplicates", () => {
    expect(
      normalizeMeetingVocabulary([" Moss ", "", "Moss", "moss", "ボッチ", "José", "😀"])
    ).toEqual(["Moss", "moss", "ボッチ", "José", "😀"]);
  });
  it("counts UTF-8 bytes and every separator in the complete prompt", () => {
    expect(meetingTranscriptionOptions("ja", ["界".repeat(65), "abc"]).prompt).toBe(
      "界".repeat(65) + ", abc"
    );
    expect(() => normalizeMeetingVocabulary(["界".repeat(65), "abcd"])).toThrow(/200/);
    expect(normalizeMeetingVocabulary(["a".repeat(200)])).toEqual(["a".repeat(200)]);
    expect(() => normalizeMeetingVocabulary(["a".repeat(201)])).toThrow(/200/);
  });
  it.each([
    null,
    "Moss",
    [1],
    ["a\nb"],
    ["a\tb"],
    ["x\u2028y"],
    ["a\ud800"],
    ["a".repeat(1001)],
    Array(101).fill(""),
    Array.from({ length: 21 }, (_, i) => String(i))
  ])("rejects malformed or oversized input %j", (value) => {
    expect(() => normalizeMeetingVocabulary(value)).toThrow();
  });
  it("omits empty hints and requires explicit language for nonempty hints", () => {
    expect(meetingTranscriptionOptions(null, [])).toEqual({});
    expect(meetingTranscriptionOptions("es", [])).toEqual({ language: "es" });
    expect(() => meetingTranscriptionOptions(null, ["José"])).toThrow(/language/);
    expect(meetingTranscriptionOptions("es", ["José", "Moss"])).toEqual({
      language: "es",
      prompt: "José, Moss"
    });
  });
});
