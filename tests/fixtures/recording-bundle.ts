import { createHash } from "node:crypto";
import type { MeetingRecordingImportInput } from "@moss/shared";
export function recordingFile(name: string, bytes: Uint8Array) {
  return {
    name,
    base64: Buffer.from(bytes).toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
export function recordingBundle(hold = false): MeetingRecordingImportInput {
  const id = `${hold ? "amsg_" : ""}1792470000_mono`;
  const wav = Buffer.alloc(44 + 3840);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(3840, 40);
  return {
    version: 1,
    sourceDeviceId: "a0000000-0000-4000-8000-000000000001",
    recordingId: id,
    packets: recordingFile(`${id}.opus`, Buffer.from([255, 1, 0, 0, 1, 0])),
    sidecar: recordingFile(
      `${id}.json`,
      Buffer.from(
        '{"record":["1792470000","start"]},{"btn":["1792470000000","1"]},{"unknown":{"preserve":true}},{"duration":["1792470000","120"]},{"record":["1792470000","end"]}'
      )
    ),
    wav: recordingFile(`${id}.wav`, wav)
  };
}
