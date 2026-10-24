import { describe, expect, it } from "vitest";
import { normalizeWindowTranscript } from "../../packages/meetings/src/recording-transcription-window.js";

describe("imported recording transcript bounds", () => {
  it("accepts the measured trailing drift without mutating the provider response", () => {
    const segments = Object.freeze([
      Object.freeze({ startMs: 29_840, endMs: 30_340, text: "At the boundary" })
    ]);
    expect(normalizeWindowTranscript(segments, 30_000)).toEqual([
      { startMs: 29_840, endMs: 30_000, text: "At the boundary" }
    ]);
    expect(segments[0]!.endMs).toBe(30_340);
  });

  it.each([0, 340, 500])("bounds %s ms of end drift in a short final window", (drift) => {
    expect(
      normalizeWindowTranscript([{ startMs: 0, endMs: 500 + drift, text: "Final" }], 500)
    ).toEqual([{ startMs: 0, endMs: 500, text: "Final" }]);
  });

  it.each([
    { startMs: 0, endMs: 30_501, text: "Excessive drift" },
    { startMs: 30_000, endMs: 30_340, text: "Starts at end" },
    { startMs: 30_100, endMs: 30_340, text: "Outside audio" },
    { startMs: -1, endMs: 1, text: "Negative" },
    { startMs: 1, endMs: 1, text: "Empty interval" },
    { startMs: 2, endMs: 1, text: "Reversed" },
    { startMs: 0.5, endMs: 1, text: "Fractional start" },
    { startMs: 0, endMs: 1.5, text: "Fractional end" },
    { startMs: 0, endMs: Number.NaN, text: "NaN" },
    { startMs: 0, endMs: Number.POSITIVE_INFINITY, text: "Infinity" }
  ])("rejects invalid interval $text", (segment) => {
    expect(() => normalizeWindowTranscript([segment], 30_000)).toThrow(
      "Invalid recording window transcript"
    );
  });

  it("preserves in-range segments and silence while enforcing output budgets", () => {
    const segment = { startMs: 0, endMs: 1, text: "Hello" };
    expect(normalizeWindowTranscript([segment], 30_000)).toEqual([segment]);
    expect(normalizeWindowTranscript([], 500)).toEqual([]);
    expect(() =>
      normalizeWindowTranscript(
        Array.from({ length: 81 }, () => segment),
        30_000
      )
    ).toThrow("Invalid recording window transcript");
    expect(() =>
      normalizeWindowTranscript([{ ...segment, text: "x".repeat(5001) }], 30_000)
    ).toThrow("Invalid recording window transcript");
  });
});
