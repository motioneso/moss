import { createServer } from "node:http";

export const CAPTURE_FIXTURE_PORT = 8086;
export const CAPTURE_FIXTURE_MODEL = "meeting-capture-uat-http";
export const CAPTURE_FIXTURE_TEXT =
  "Synthetic meeting audio reached the configured transcription route.";
export const CAPTURE_SAMPLE_RATE = 16000;
export function syntheticMeetingPcm(durationMs: number): Buffer {
  const samples = Math.round((CAPTURE_SAMPLE_RATE * durationMs) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++)
    pcm.writeInt16LE(
      Math.round(2000 * Math.sin((2 * Math.PI * 440 * index) / CAPTURE_SAMPLE_RATE)),
      index * 2
    );
  return pcm;
}
/** Validates the actual multipart WAV sent by Moss. This never transcribes real speech. */
export async function fixtureTranscription(form: FormData) {
  const file = form.get("file");
  if (
    !(file instanceof Blob) ||
    form.get("model") !== CAPTURE_FIXTURE_MODEL ||
    form.get("response_format") !== "verbose_json" ||
    form.get("timestamp_granularities[]") !== "segment"
  )
    throw new Error("Invalid synthetic transcription request");
  const wave = Buffer.from(await file.arrayBuffer());
  if (
    wave.length <= 44 ||
    wave.toString("ascii", 0, 4) !== "RIFF" ||
    wave.toString("ascii", 8, 16) !== "WAVEfmt " ||
    wave.readUInt32LE(24) !== CAPTURE_SAMPLE_RATE ||
    wave.readUInt16LE(22) !== 1 ||
    wave.readUInt16LE(34) !== 16 ||
    wave.readUInt32LE(40) !== wave.length - 44
  )
    throw new Error("Invalid synthetic WAV");
  const durationMs = ((wave.length - 44) / 2 / CAPTURE_SAMPLE_RATE) * 1000;
  if (
    durationMs < 20 ||
    durationMs > 10000 ||
    !wave.subarray(44).equals(syntheticMeetingPcm(durationMs))
  )
    throw new Error("Unexpected audio; generated PCM only");
  return {
    body: {
      text: CAPTURE_FIXTURE_TEXT,
      segments: [{ start: 0, end: durationMs / 1000, text: CAPTURE_FIXTURE_TEXT }]
    },
    observation: {
      model: CAPTURE_FIXTURE_MODEL,
      audioBytes: wave.length,
      durationMs,
      sampleRateHz: CAPTURE_SAMPLE_RATE,
      channels: 1,
      timestampsRequested: true,
      generatedPcm: true
    }
  };
}

/** Disclosed isolated third-party stand-in. No interception of Moss routes or responses. */
export async function startMeetingCaptureFixtureServer(port = CAPTURE_FIXTURE_PORT) {
  const observations: Awaited<ReturnType<typeof fixtureTranscription>>["observation"][] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && path === "/evidence") return send(200, { observations });
    if (request.method === "GET" && path === "/v1/models") return send(200, { data: [] });
    if (request.method !== "POST" || path !== "/v1/audio/transcriptions") return send(404, {});
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4000000) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        try {
          const body = Uint8Array.from(Buffer.concat(chunks));
          const form = await new Request("http://fixture.invalid/v1/audio/transcriptions", {
            method: "POST",
            headers: { "content-type": request.headers["content-type"] ?? "" },
            body
          }).formData();
          const result = await fixtureTranscription(form);
          observations.push(result.observation);
          send(200, result.body);
        } catch {
          send(400, { error: "Invalid generated audio fixture" });
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  return {
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}
