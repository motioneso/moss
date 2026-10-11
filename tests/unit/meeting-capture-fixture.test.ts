import { describe, expect, it } from "vitest";
import { pcmWave } from "../../packages/meetings/src/capture-domain.js";
import {
  CAPTURE_FIXTURE_MODEL,
  CAPTURE_FIXTURE_TEXT,
  CAPTURE_SAMPLE_RATE,
  fixtureTranscription,
  syntheticMeetingPcm
} from "../uat/fixtures/meeting-capture-fixture-server.js";

function form(durationMs = 200) {
  const input = new FormData();
  input.set("model", CAPTURE_FIXTURE_MODEL);
  input.set("response_format", "verbose_json");
  input.set("timestamp_granularities[]", "segment");
  input.set(
    "file",
    new Blob([Uint8Array.from(pcmWave(syntheticMeetingPcm(durationMs), CAPTURE_SAMPLE_RATE))], {
      type: "audio/wav"
    }),
    "audio"
  );
  return input;
}
describe("disclosed synthetic capture ASR fixture", () => {
  it("validates generated PCM in real multipart serialization and returns bounded timestamps", async () => {
    const request = new Request("http://fixture.invalid/v1/audio/transcriptions", {
      method: "POST",
      body: form()
    });
    const result = await fixtureTranscription(await request.formData());
    expect(result.body).toEqual({
      text: CAPTURE_FIXTURE_TEXT,
      segments: [{ start: 0, end: 0.2, text: CAPTURE_FIXTURE_TEXT }]
    });
    expect(result.observation).toEqual({
      model: CAPTURE_FIXTURE_MODEL,
      audioBytes: 6444,
      durationMs: 200,
      sampleRateHz: 16000,
      channels: 1,
      timestampsRequested: true,
      generatedPcm: true
    });
    expect(JSON.stringify(result.observation)).not.toContain(CAPTURE_FIXTURE_TEXT);
  });
  it("rejects arbitrary microphone data rather than pretending to transcribe it", async () => {
    const input = form();
    input.set(
      "file",
      new Blob([Uint8Array.from(pcmWave(Buffer.alloc(6400), CAPTURE_SAMPLE_RATE))])
    );
    await expect(fixtureTranscription(input)).rejects.toThrow("generated PCM only");
  });
  it("requires the configured model and explicit timestamp request", async () => {
    const wrong = form();
    wrong.set("model", "unconfigured");
    await expect(fixtureTranscription(wrong)).rejects.toThrow(
      "Invalid synthetic transcription request"
    );
    const noTimestamps = form();
    noTimestamps.delete("timestamp_granularities[]");
    await expect(fixtureTranscription(noTimestamps)).rejects.toThrow(
      "Invalid synthetic transcription request"
    );
  });
});
