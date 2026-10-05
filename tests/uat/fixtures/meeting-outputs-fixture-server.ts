import { createServer } from "node:http";
import type { MeetingOutputContent, MeetingOutputInputs } from "@moss/shared";

export const OUTPUT_FIXTURE_PORT = 8085;
export const OUTPUT_FIXTURE_MODEL = "meeting-output-uat-http";
export const OUTPUT_FIXTURE_TEXT =
  "The synthetic team decided to ship Orchid. Alex will review Orchid tomorrow.";
export const OUTPUT_FIXTURE_OVERVIEW = "Synthetic Orchid review summary";
export const OUTPUT_FIXTURE_DECISION = "Ship Orchid";
export const OUTPUT_FIXTURE_ACTION = "Review Orchid";
export const OUTPUT_FIXTURE_MANUAL = "Owner edited synthetic Orchid summary";
const MARKER = "externalData (escaped JSON):\n";

/** Dynamic evidence is derived from the real outbound source, never guessed fixture IDs. */
export function fixtureOutput(body: Record<string, unknown>): {
  content: MeetingOutputContent;
  observation: {
    model: unknown;
    hasTools: boolean;
    hasSearch: boolean;
    exactSource: boolean;
    sourceCount: number;
    promptBytes: number;
  };
} {
  const messages = body.messages as { content?: unknown }[];
  const prompt = messages
    ?.map((message) => message.content)
    .find((content): content is string => typeof content === "string" && content.includes(MARKER));
  if (!prompt) throw new Error("Missing structured source input");
  const inputs = JSON.parse(
    prompt.slice(prompt.indexOf(MARKER) + MARKER.length)
  ) as MeetingOutputInputs;
  const segment = inputs.transcript?.segments[0];
  if (!segment || segment.text !== OUTPUT_FIXTURE_TEXT || segment.meetingId !== inputs.meetingId)
    throw new Error("Unexpected synthetic source");
  const evidence = [
    {
      kind: "transcript" as const,
      meetingId: inputs.meetingId,
      segmentId: segment.segmentId,
      segmentRevision: segment.revision,
      startCharacter: 0,
      endCharacter: segment.text.length
    }
  ];
  return {
    content: {
      overview: OUTPUT_FIXTURE_OVERVIEW,
      decisions: [{ text: OUTPUT_FIXTURE_DECISION, evidence }],
      actions: [
        { text: OUTPUT_FIXTURE_ACTION, evidence, ownerPhrase: "Alex", duePhrase: "tomorrow" }
      ],
      openQuestions: [],
      warnings: []
    },
    observation: {
      model: body.model,
      hasTools: "tools" in body || "functions" in body || "tool_choice" in body,
      hasSearch:
        "web_search_options" in body || "nativeSearch" in body || "search_parameters" in body,
      exactSource: segment.text === OUTPUT_FIXTURE_TEXT,
      sourceCount: inputs.transcript!.segments.length,
      promptBytes: Buffer.byteLength(prompt, "utf8")
    }
  };
}

// Isolated third-party HTTP stand-in. Moss routes/services are not intercepted or replayed.
// Retain bounded observations only, never prompts, headers or private source text.
export async function startMeetingOutputsFixtureServer(port = OUTPUT_FIXTURE_PORT) {
  const observations: ReturnType<typeof fixtureOutput>["observation"][] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && path === "/evidence") return send(200, { observations });
    if (request.method === "GET" && path === "/v1/models") return send(200, { data: [] });
    if (request.method !== "POST" || path !== "/v1/chat/completions") return send(404, {});
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const { content, observation } = fixtureOutput(
          JSON.parse(Buffer.concat(chunks).toString("utf8"))
        );
        observations.push(observation);
        send(200, {
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
          usage: { prompt_tokens: 100, completion_tokens: 80 }
        });
      } catch {
        send(400, { error: "Invalid synthetic summary request" });
      }
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
