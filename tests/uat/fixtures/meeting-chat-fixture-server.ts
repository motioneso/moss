import { createServer } from "node:http";

// Third-party HTTP stand-in, never a replacement for a Moss route. The evidence endpoint
// retains only bounded assertions about synthetic input, not prompts or request headers.
export const MEETING_FIXTURE_MODEL = "meeting-uat-http";
export const MEETING_FIXTURE_QUESTION = "What is the synthetic meeting decision?";
export const MEETING_FIXTURE_OLD = "SYNTHETIC_DECISION_ORCHID";
export const MEETING_FIXTURE_NEW = "SYNTHETIC_DECISION_MAPLE";
export const MEETING_FIXTURE_UNRELATED = "SYNTHETIC_OTHER_MEETING_SECRET";
export const MEETING_FIXTURE_REPLY = "The synthetic decision is recorded in the transcript. [[S1]]";
export const MEETING_FIXTURE_PORT = 8084;

export interface MeetingFixtureObservation {
  readonly path: string;
  readonly model: string | null;
  readonly hasTools: boolean;
  readonly hasNativeSearch: boolean;
  readonly hasOld: boolean;
  readonly hasNew: boolean;
  readonly hasUnrelated: boolean;
  readonly hasExternalSource: boolean;
}

export function observeMeetingFixtureRequest(
  path: string,
  body: Record<string, unknown>
): MeetingFixtureObservation | null {
  const text = JSON.stringify(body);
  if (!text.includes(MEETING_FIXTURE_QUESTION)) return null;
  return {
    path,
    model: typeof body.model === "string" ? body.model : null,
    hasTools: "tools" in body || "functions" in body || "tool_choice" in body,
    hasNativeSearch:
      path !== "/v1/chat/completions" ||
      "nativeSearch" in body ||
      "web_search_options" in body ||
      "search_parameters" in body,
    hasOld: text.includes(MEETING_FIXTURE_OLD),
    hasNew: text.includes(MEETING_FIXTURE_NEW),
    hasUnrelated: text.includes(MEETING_FIXTURE_UNRELATED),
    hasExternalSource: text.includes("external_source")
  };
}

export async function startMeetingChatFixtureServer(port = MEETING_FIXTURE_PORT) {
  const observations: MeetingFixtureObservation[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && path === "/evidence") {
      send(200, { observations });
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      send(200, { data: [] });
      return;
    }
    if (request.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(path)) {
      send(404, { error: "Unknown fixture route" });
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const observation = observeMeetingFixtureRequest(path, body);
        if (observation) observations.push(observation);
        send(200, {
          choices: [{ message: { role: "assistant", content: MEETING_FIXTURE_REPLY } }],
          usage: { prompt_tokens: 32, completion_tokens: 16 }
        });
      } catch {
        send(400, { error: "Invalid fixture request" });
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
