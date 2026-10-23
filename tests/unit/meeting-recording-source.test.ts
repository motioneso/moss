import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { validateRecordingBundle } from "@moss/meetings";
import {
  RecordingPacketValidator,
  recordingSidecarMetadata,
  recordingWavDuration
} from "../../packages/meetings/src/recording-audio-validation.js";
import {
  RECORDING_SOURCE_LIMITS,
  validateRecordingSource,
  type RecordingSourceFiles,
  type RecordingSourceKind,
  type RecordingSourceReader
} from "../../packages/meetings/src/recording-source-validation.js";
import { RecordingImportInputError } from "../../packages/meetings/src/recording-validation-error.js";
import { recordingBundle } from "../fixtures/recording-bundle.js";
import { recordingUpload } from "../fixtures/recording-upload.js";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function fixture() {
  const bundle = recordingBundle();
  const bytes: Record<RecordingSourceKind, Buffer> = {
    packets: Buffer.from(bundle.packets.base64, "base64"),
    sidecar: Buffer.from(bundle.sidecar.base64, "base64"),
    wav: Buffer.from(bundle.wav.base64, "base64")
  };
  return { bundle, bytes };
}
function source(bytes: Record<RecordingSourceKind, Buffer>, splitAt = 0) {
  const file = (kind: RecordingSourceKind) => ({
    byteLength: bytes[kind].length,
    sha256: digest(bytes[kind])
  });
  const files: RecordingSourceFiles = {
    packets: file("packets"),
    sidecar: file("sidecar"),
    wav: file("wav")
  };
  const read: RecordingSourceReader = async function* (kind) {
    yield bytes[kind].subarray(0, splitAt);
    yield bytes[kind].subarray(splitAt);
  };
  return { files, read };
}
function wavHeader(durationMs: number): Buffer {
  const header = fixture().bytes.wav.subarray(0, 44);
  header.writeUInt32LE(44 + durationMs * 32 - 8, 4);
  header.writeUInt32LE(durationMs * 32, 40);
  return header;
}
function metadata(durationMs: number, elapsedDifferenceMs = 0): Buffer {
  const start = 1_792_470_000_000;
  return Buffer.from(
    [
      { record: [String(start), "start"] },
      { btn: [String(start + durationMs), "1"] },
      { unknown: "preserved 🦉" },
      { duration: [String(start + durationMs), String(durationMs)] },
      { record: [String(start + durationMs + elapsedDifferenceMs), "end"] }
    ]
      .map((entry) => JSON.stringify(entry))
      .join(",")
  );
}

describe("incremental source validation", () => {
  it("accepts measured ring-clock drift in a 42-minute source with matching decoded duration", async () => {
    const durationMs = 2_513_160;
    const original = recordingUpload(durationMs);
    const sidecar = metadata(durationMs, -4_160);
    const read: RecordingSourceReader = async function* (kind) {
      if (kind === "sidecar") yield sidecar;
      else yield* original.chunks(kind);
    };
    const result = await validateRecordingSource(
      {
        ...original.manifest,
        sidecar: { byteLength: sidecar.length, sha256: digest(sidecar) }
      },
      read
    );
    expect(result.durationMs).toBe(durationMs);
    expect(result.recordedDurationMs).toBe(durationMs);
    expect(result.endMs - result.startMs).toBe(durationMs - 4_160);
  });

  it.each([-1_501, 1_501])("retains the short-recording clock bound at %s ms", (drift) => {
    expect(() =>
      recordingSidecarMetadata(metadata(120_000, drift), 120_000, {
        maxBytes: 256 * 1024,
        maxEntries: 256 * 1024,
        durationDigits: 7
      })
    ).toThrow(RecordingImportInputError);
  });

  it.each([-30_000, 30_000])("rejects excessive long-recording clock drift of %s ms", (drift) => {
    expect(() =>
      recordingSidecarMetadata(metadata(2_513_160, drift), 2_513_160, {
        maxBytes: 256 * 1024,
        maxEntries: 256 * 1024,
        durationDigits: 7
      })
    ).toThrow(RecordingImportInputError);
  });

  it("rejects a mismatched declared duration despite acceptable long-recording clock drift", () => {
    expect(() =>
      recordingSidecarMetadata(metadata(2_513_160, -4_160), 2_515_000, {
        maxBytes: 256 * 1024,
        maxEntries: 256 * 1024,
        durationDigits: 7
      })
    ).toThrow(RecordingImportInputError);
  });

  it("validates every byte split of the WAV header and UTF8 sidecar", async () => {
    const { bundle, bytes } = fixture();
    bytes.sidecar = metadata(120);
    const legacy = validateRecordingBundle(bundle);
    for (let split = 0; split <= bytes.sidecar.length; split++) {
      const { files, read } = source(bytes, split);
      const result = await validateRecordingSource(files, read);
      expect(result.durationMs).toBe(legacy.durationMs);
      expect(result.packetCount).toBe(2);
      expect(result.bookmarksMs).toEqual([120]);
    }
  });

  it("validates maximum-length payloads across every packet split, including sequence wrap", () => {
    const bytes = Buffer.concat([
      Buffer.from([255, 255]),
      Buffer.alloc(255, 255),
      Buffer.from([0, 1, 42])
    ]);
    for (let split = 0; split <= bytes.length; split++) {
      const parser = new RecordingPacketValidator();
      parser.push(bytes.subarray(0, split));
      parser.push(bytes.subarray(split));
      expect(parser.finish()).toBe(2);
    }
    const bytewise = new RecordingPacketValidator();
    for (const byte of bytes) bytewise.push(Uint8Array.of(byte));
    expect(bytewise.finish()).toBe(2);
  });

  it.each([[], [0], [0, 0], [0, 1], [0, 2, 1], [255, 1, 1, 1, 1, 1]])(
    "rejects incomplete or discontinuous packets %j",
    (...values: number[]) => {
      const parser = new RecordingPacketValidator();
      expect(() => {
        for (const byte of values) parser.push(Uint8Array.of(byte));
        parser.finish();
      }).toThrow(RecordingImportInputError);
    }
  );

  it.each(["packets", "sidecar", "wav"] as const)(
    "rejects changed %s bytes with the old whole-file hash",
    async (kind) => {
      const { bytes } = fixture();
      const { files, read } = source(bytes);
      const last = bytes[kind].length - 1;
      bytes[kind][last] = bytes[kind][last]! ^ 1;
      await expect(validateRecordingSource(files, read)).rejects.toBeInstanceOf(
        RecordingImportInputError
      );
    }
  );

  it.each([-1, 1])("rejects actual file length differing by %s", async (difference) => {
    const { bytes } = fixture();
    const { files, read } = source(bytes);
    await expect(
      validateRecordingSource(
        { ...files, wav: { ...files.wav, byteLength: files.wav.byteLength + difference } },
        read
      )
    ).rejects.toBeInstanceOf(RecordingImportInputError);
  });

  it.each(["packets", "sidecar", "wav"] as const)(
    "checks %s file size before invoking the reader",
    async (kind) => {
      const { files, read } = source(fixture().bytes);
      const observed = vi.fn(read);
      await expect(
        validateRecordingSource(
          { ...files, [kind]: { ...files[kind], byteLength: RECORDING_SOURCE_LIMITS[kind] + 1 } },
          observed
        )
      ).rejects.toMatchObject({ statusCode: 413 });
      expect(observed).not.toHaveBeenCalled();
    }
  );

  it.each([0, -1, 0.5, NaN, Infinity])("rejects invalid declared size %s", async (byteLength) => {
    const { files, read } = source(fixture().bytes);
    await expect(
      validateRecordingSource({ ...files, wav: { ...files.wav, byteLength } }, read)
    ).rejects.toBeInstanceOf(RecordingImportInputError);
  });

  it("rejects a source chunk larger than 1 MiB", async () => {
    const { files } = source(fixture().bytes);
    const read: RecordingSourceReader = async function* () {
      yield Buffer.alloc(RECORDING_SOURCE_LIMITS.chunk + 1);
    };
    await expect(validateRecordingSource(files, read)).rejects.toMatchObject({ statusCode: 413 });
  });

  it("rejects changed WAV geometry even with a matching whole-file hash", async () => {
    const { bytes } = fixture();
    bytes.wav.writeUInt32LE(48000, 24);
    const { files, read } = source(bytes);
    await expect(validateRecordingSource(files, read)).rejects.toBeInstanceOf(
      RecordingImportInputError
    );
  });

  it.each([0, 8, 36])("rejects a high-bit WAV tag byte at %s", async (offset) => {
    const { bytes } = fixture();
    bytes.wav[offset] = bytes.wav[offset]! | 0x80;
    const { files, read } = source(bytes);
    await expect(validateRecordingSource(files, read)).rejects.toBeInstanceOf(
      RecordingImportInputError
    );
  });

  it("rejects valid packet framing inconsistent with the WAV duration", async () => {
    const { bytes } = fixture();
    bytes.packets = Buffer.from([0, 1, 0]);
    const { files, read } = source(bytes);
    await expect(validateRecordingSource(files, read)).rejects.toBeInstanceOf(
      RecordingImportInputError
    );
  });

  it("rejects a partial sidecar despite a matching file hash", async () => {
    const { bytes } = fixture();
    bytes.sidecar = Buffer.from('{"record":["1792470000","start"]}');
    const { files, read } = source(bytes);
    await expect(validateRecordingSource(files, read)).rejects.toBeInstanceOf(
      RecordingImportInputError
    );
  });

  it("validates a generated two-hour source using bounded buffers", async () => {
    const durationMs = RECORDING_SOURCE_LIMITS.durationMs;
    const header = wavHeader(durationMs);
    const sidecar = metadata(durationMs);
    const packets = Buffer.alloc((durationMs / 60) * 3);
    for (let i = 0; i < packets.length / 3; i++) {
      packets[i * 3] = i % 256;
      packets[i * 3 + 1] = 1;
    }
    const zeros = Buffer.alloc(RECORDING_SOURCE_LIMITS.chunk);
    const read: RecordingSourceReader = async function* (kind) {
      if (kind === "packets") {
        yield packets;
        return;
      }
      if (kind === "sidecar") {
        yield sidecar;
        return;
      }
      // Split RIFF across chunks; never allocate the 230 MiB PCM payload.
      yield header.subarray(0, 3);
      yield header.subarray(3);
      for (let remaining = durationMs * 32; remaining > 0; remaining -= zeros.length) {
        yield zeros.subarray(0, Math.min(remaining, zeros.length));
      }
    };
    const wavHash = createHash("sha256");
    for await (const chunk of read("wav")) wavHash.update(chunk);
    const files: RecordingSourceFiles = {
      packets: { byteLength: packets.length, sha256: digest(packets) },
      sidecar: { byteLength: sidecar.length, sha256: digest(sidecar) },
      wav: { byteLength: 44 + durationMs * 32, sha256: wavHash.digest("hex") }
    };
    const allocation = vi.spyOn(Buffer, "alloc");
    try {
      const result = await validateRecordingSource(files, read);
      expect(result).toMatchObject({
        durationMs,
        packetCount: 120_000,
        bookmarksMs: [durationMs],
        recordedDurationMs: durationMs
      });
      expect(
        allocation.mock.calls.every(([length]) => length <= RECORDING_SOURCE_LIMITS.chunk)
      ).toBe(true);
    } finally {
      allocation.mockRestore();
    }
  });
});

describe("duration boundaries and version-1 compatibility", () => {
  it("rejects two hours plus 1 ms and non-integer PCM duration", () => {
    for (const duration of [7_200_001, 120.0625]) {
      expect(() =>
        recordingWavDuration(wavHeader(duration), 44 + duration * 32, 7_200_000)
      ).toThrow(RecordingImportInputError);
    }
  });

  it("retains the legacy WAV limit and six-digit sidecar duration", () => {
    expect(() => recordingWavDuration(wavHeader(120_001), 44 + 120_001 * 32, 120_000)).toThrow(
      expect.objectContaining({ statusCode: 413 })
    );
    const limits = { maxBytes: 256 * 1024, maxEntries: 512, durationDigits: 6 };
    expect(() => recordingSidecarMetadata(metadata(7_200_000), 7_200_000, limits)).toThrow(
      RecordingImportInputError
    );
    expect(
      recordingSidecarMetadata(metadata(7_200_000), 7_200_000, { ...limits, durationDigits: 7 })
        .bookmarksMs
    ).toEqual([7_200_000]);
  });
});
