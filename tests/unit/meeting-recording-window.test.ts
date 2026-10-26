import { describe, expect, it, vi } from "vitest";
import {
  normalizeWindowTranscript,
  transcribeWindowWithRetry
} from "../../packages/meetings/src/recording-transcription-window.js";

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

function pcmWindow(durationMs = 30_000, amplitude = 12_000) {
  const audio = Buffer.alloc(44 + durationMs * 32);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24);
  audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  for (let offset = 44; offset < audio.length; offset += 2)
    audio.writeInt16LE(((offset - 44) % 4 ? -1 : 1) * amplitude, offset);
  return audio;
}
const phrase = "one two three four five six seven eight nine ten";
const thin = [{ startMs: 0, endMs: 1000, text: "Two words" }];
const half = [{ startMs: 0, endMs: 15_000, text: phrase }];

describe("thin audible recording pieces", () => {
  it("retries exactly once as two unchanged PCM halves and keeps the richer transcript", async () => {
    const audio = pcmWindow();
    for (let offset = 44 + 15_000 * 32; offset < audio.length; offset += 2)
      audio.writeInt16LE(offset % 4 ? -8000 : 8000, offset);
    const before = Buffer.from(audio);
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: thin })
      .mockResolvedValue({ segments: half });
    const result = await transcribeWindowWithRetry(audio, 30_000, transcribe);
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(result).toEqual([...half, { ...half[0]!, startMs: 15_000, endMs: 30_000 }]);
    const first = transcribe.mock.calls[1]![0] as Buffer;
    const second = transcribe.mock.calls[2]![0] as Buffer;
    for (const part of [first, second]) {
      expect(part.length).toBe(44 + 15_000 * 32);
      expect(part.readUInt32LE(4)).toBe(part.length - 8);
      expect(part.readUInt32LE(40)).toBe(part.length - 44);
    }
    expect(first.subarray(44)).toEqual(audio.subarray(44, 44 + 15_000 * 32));
    expect(second.subarray(44)).toEqual(audio.subarray(44 + 15_000 * 32));
    expect(audio).toEqual(before);
  });

  it.each([0, 100, 580])(
    "does not retry silent or quiet PCM at amplitude %s",
    async (amplitude) => {
      const transcribe = vi.fn().mockResolvedValue({ segments: thin });
      expect(
        await transcribeWindowWithRetry(pcmWindow(30_000, amplitude), 30_000, transcribe)
      ).toEqual(thin);
      expect(transcribe).toHaveBeenCalledTimes(1);
    }
  );

  it("does not retry a full piece with enough words", async () => {
    const full = [{ startMs: 0, endMs: 30_000, text: `${phrase} ${phrase}` }];
    const transcribe = vi.fn().mockResolvedValue({ segments: full });
    expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toEqual(full);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("retries a sparse segment stretched across the whole piece", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: [{ ...thin[0]!, endMs: 30_000 }] })
      .mockResolvedValue({ segments: half });
    expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toHaveLength(2);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it("uses unique coverage even when overlapping segments have enough words", async () => {
    const original = Array.from({ length: 4 }, () => ({ startMs: 0, endMs: 2000, text: phrase }));
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: original })
      .mockResolvedValue({ segments: [] });
    expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toEqual(original);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it("prefers more words even when retry timestamp coverage is smaller", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: [{ ...thin[0]!, endMs: 30_000 }] })
      .mockResolvedValue({ segments: [{ startMs: 0, endMs: 1000, text: phrase }] });
    const result = await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe);
    expect(result.map((s) => s.text)).toEqual([phrase, phrase]);
  });

  it.each([{ segments: [] }, { segments: [{ startMs: 0, endMs: 15_000, text: "One" }] }])(
    "keeps the original for a weaker or tied retry: %j",
    async ({ segments }) => {
      const transcribe = vi
        .fn()
        .mockResolvedValueOnce({ segments: thin })
        .mockResolvedValue({ segments });
      expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toEqual(thin);
      expect(transcribe).toHaveBeenCalledTimes(3);
    }
  );

  it("does not recursively retry when both halves are still thin", async () => {
    const transcribe = vi.fn().mockResolvedValue({ segments: thin });
    expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toHaveLength(2);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it("counts blank text as no speech and handles empty first results", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: [{ startMs: 0, endMs: 30_000, text: "   " }] })
      .mockResolvedValue({ segments: half });
    expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toHaveLength(2);
    transcribe
      .mockReset()
      .mockResolvedValueOnce({ segments: [] })
      .mockResolvedValue({ segments: half });
    expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toHaveLength(2);
  });

  it("clamps each half before offsetting the second half", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: thin })
      .mockResolvedValue({ segments: [{ startMs: 100, endMs: 15_340, text: phrase }] });
    expect(await transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).toEqual([
      { startMs: 100, endMs: 15_000, text: phrase },
      { startMs: 15_100, endMs: 30_000, text: phrase }
    ]);
  });

  it("splits a short final piece without escaping its duration", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: [] })
      .mockResolvedValueOnce({ segments: [{ startMs: 0, endMs: 1100, text: phrase }] })
      .mockResolvedValueOnce({ segments: [{ startMs: 0, endMs: 1101, text: phrase }] });
    expect(await transcribeWindowWithRetry(pcmWindow(2001), 2001, transcribe)).toEqual([
      { startMs: 0, endMs: 1000, text: phrase },
      { startMs: 1000, endMs: 2001, text: phrase }
    ]);
  });

  it("propagates a rejected half request without dispatching the next half", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: thin })
      .mockRejectedValue(new Error("Aborted"));
    await expect(transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).rejects.toThrow(
      "Aborted"
    );
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("enforces the original combined output budget on the retry", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ segments: thin })
      .mockResolvedValue({ segments: [{ startMs: 0, endMs: 15_000, text: "word ".repeat(600) }] });
    await expect(transcribeWindowWithRetry(pcmWindow(), 30_000, transcribe)).rejects.toThrow(
      "Invalid recording window transcript"
    );
  });
});
