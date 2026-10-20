import { describe, expect, it } from "vitest";
import {
  RECORDING_IMPORT_QUEUES,
  RecordingImportInputError,
  validateRecordingBundle
} from "@moss/meetings";
import { recordingBundle, recordingFile } from "../fixtures/recording-bundle.js";
describe("completed legacy recording validation", () => {
  it.each([false, true])("preserves canonical evidence and normalized mode: hold=%s", (hold) => {
    const input = recordingBundle(hold),
      result = validateRecordingBundle(input);
    expect(result.mode).toBe(hold ? "voice-request" : "normal");
    expect(result.bookmarksMs).toEqual([0]);
    expect(result.durationMs).toBe(120);
    expect(result.recordedDurationMs).toBe(120);
    expect(JSON.parse(result.canonical).sidecar).toEqual(input.sidecar);
    expect(validateRecordingBundle({ ...input, version: 1 }).fingerprint).toBe(result.fingerprint);
    expect(
      validateRecordingBundle({ ...input, sourceDeviceId: input.sourceDeviceId.toUpperCase() })
        .fingerprint
    ).toBe(result.fingerprint);
  });
  it.each([
    (i: ReturnType<typeof recordingBundle>) => ({ ...i, extra: true }),
    (i: ReturnType<typeof recordingBundle>) => ({ ...i, version: 2 }),
    (i: ReturnType<typeof recordingBundle>) => ({ ...i, sourceDeviceId: "MAC-address" }),
    (i: ReturnType<typeof recordingBundle>) => ({ ...i, recordingId: "../escape" }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      packets: { ...i.packets, sha256: "0".repeat(64) }
    }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      packets: { ...i.packets, base64: "AA=== " }
    }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      packets: { ...i.packets, name: "different.opus" }
    }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      packets: recordingFile(i.packets.name, Buffer.from([1, 1, 0, 3, 1, 0]))
    }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      packets: recordingFile(i.packets.name, Buffer.from([1, 2, 0]))
    }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      sidecar: recordingFile(i.sidecar.name, Buffer.from("[{}]"))
    }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      sidecar: recordingFile(
        i.sidecar.name,
        Buffer.from(
          '{"record":["1792470000","start"]},{"btn":["1792470001","1"]},{"duration":["1792470000","120"]},{"record":["1792470000","end"]}'
        )
      )
    }),
    (i: ReturnType<typeof recordingBundle>) => ({
      ...i,
      wav: recordingFile(i.wav.name, Buffer.alloc(46))
    })
  ])("rejects malformed or conflicting evidence %#", (change) => {
    expect(() => validateRecordingBundle(change(recordingBundle()))).toThrow(
      RecordingImportInputError
    );
  });
  it.each([
    ["packets", 1024 * 1024],
    ["sidecar", 64 * 1024],
    ["wav", 3_840_044]
  ] as const)("bounds %s before decoding", (key, limit) => {
    const input = recordingBundle();
    expect(() =>
      validateRecordingBundle({
        ...input,
        [key]: { ...input[key], base64: "A".repeat(4 * Math.ceil(limit / 3) + 4) }
      })
    ).toThrow(expect.objectContaining({ statusCode: 413 }));
  });
  it("rejects noncanonical base64 even if decoded bytes have the expected hash", () => {
    const input = recordingBundle(),
      bytes = Buffer.from([255]);
    expect(() =>
      validateRecordingBundle({
        ...input,
        packets: { ...recordingFile(input.packets.name, bytes), base64: "/x==" }
      })
    ).toThrow(RecordingImportInputError);
  });
  it("keeps accepted import work queued through a multi-day outage", () => {
    const retention = RECORDING_IMPORT_QUEUES[0]!.options!.retentionSeconds!;
    expect(retention).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
  });
});
