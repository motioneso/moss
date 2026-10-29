import { createHash, randomUUID } from "node:crypto";
import type { MeetingRecordingUploadManifest } from "@moss/shared";

const chunkBytes = 1024 * 1024;
/** Generated PCM/framing fixtures are transport evidence, never hardware or ASR proof. */
export function recordingUpload(
  durationMs = 90_000,
  hold = false,
  elapsedDifferenceMs = 0,
  amplitude = 0
) {
  const recordingId = `${hold ? "amsg_" : ""}1792470000_${randomUUID().slice(0, 8)}`;
  const packets = Buffer.alloc(Math.ceil(durationMs / 60) * 3);
  for (let i = 0; i < packets.length / 3; i++) {
    packets[i * 3] = i % 256;
    packets[i * 3 + 1] = 1;
  }
  const sidecar = Buffer.from(
    `{"record":["1792470000","start"]},{"btn":["1792470001000","1"]},{"duration":["1792470000","${durationMs}"]},{"record":["${1792470000000 + durationMs + elapsedDifferenceMs}","end"]}`
  );
  const wavLength = 44 + durationMs * 32;
  function* chunks(kind: "packets" | "sidecar" | "wav") {
    const bytes = kind === "packets" ? packets : sidecar;
    const length = kind === "wav" ? wavLength : bytes.length;
    for (let offset = 0; offset < length; offset += chunkBytes) {
      if (kind !== "wav") {
        yield bytes.subarray(offset, offset + chunkBytes);
        continue;
      }
      const chunk = Buffer.alloc(Math.min(chunkBytes, length - offset));
      if (offset === 0) {
        chunk.write("RIFF");
        chunk.writeUInt32LE(length - 8, 4);
        chunk.write("WAVEfmt ", 8);
        chunk.writeUInt32LE(16, 16);
        chunk.writeUInt16LE(1, 20);
        chunk.writeUInt16LE(1, 22);
        chunk.writeUInt32LE(16000, 24);
        chunk.writeUInt32LE(32000, 28);
        chunk.writeUInt16LE(2, 32);
        chunk.writeUInt16LE(16, 34);
        chunk.write("data", 36);
        chunk.writeUInt32LE(length - 44, 40);
      }
      if (amplitude)
        for (let i = offset === 0 ? 44 : 0; i < chunk.length; i += 2)
          chunk.writeInt16LE((i % 4 ? -1 : 1) * amplitude, i);
      yield chunk;
    }
  }
  function file(kind: "packets" | "sidecar" | "wav") {
    const hash = createHash("sha256");
    let byteLength = 0;
    for (const bytes of chunks(kind)) {
      hash.update(bytes);
      byteLength += bytes.length;
    }
    return { byteLength, sha256: hash.digest("hex") };
  }
  const manifest: MeetingRecordingUploadManifest = {
    version: 3,
    sourceDeviceId: randomUUID(),
    recordingId,
    destination: { intent: "meeting" },
    packets: file("packets"),
    sidecar: file("sidecar"),
    wav: file("wav")
  };
  return { manifest, chunks };
}
