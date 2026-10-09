import { createServer } from "node:http";

// Third-party HTTP stand-in, never a replacement for a Moss route. The evidence endpoint
// retains only bounded assertions about synthetic input, not prompts or request headers.
export const MEETING_FIXTURE_MODEL = "meeting-uat-http";
export const MEETING_FIXTURE_QUESTION = "What is the synthetic meeting decision?";
export const MEETING_FIXTURE_OLD = "SYNTHETIC_DECISION_ORCHID";
export const MEETING_FIXTURE_NEW = "SYNTHETIC_DECISION_MAPLE";
export const MEETING_FIXTURE_UNRELATED = "SYNTHETIC_OTHER_MEETING_SECRET";
export const MEETING_FIXTURE_NOTES = "SYNTHETIC_NOTES_DECISION_CEDAR";
export const MEETING_FIXTURE_REPLY = "The synthetic decision is recorded in the transcript. [[S1]]";
export const MEETING_FIXTURE_LATE_REPLY = "SYNTHETIC_LATE_ANSWER_WILLOW from the held turn.";
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
  readonly hasNotes?: true;
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
    hasExternalSource: text.includes("external_source"),
    ...(text.includes(MEETING_FIXTURE_NOTES) ? { hasNotes: true as const } : {})
  };
}

type HeldOutcome = "success" | "failure";

/**
 * Starts the stand-in. POST /control/hold holds the next meeting turn; GET /control/held reports
 * whether one is waiting; POST /control/release?outcome=success|failure answers it late.
 */
export async function startMeetingChatFixtureServer(port = MEETING_FIXTURE_PORT) {
  const observations: MeetingFixtureObservation[] = [];
  let holdArmed = false;
  let heldTurn: ((outcome: HeldOutcome) => void) | undefined;
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
    if (request.method === "POST" && path === "/control/hold") {
      holdArmed = true;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && path === "/control/held") {
      send(200, { held: heldTurn !== undefined });
      return;
    }
    if (request.method === "POST" && path === "/control/release") {
      const outcome = new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get(
        "outcome"
      );
      if (outcome !== "success" && outcome !== "failure") {
        send(400, { error: "Unknown release outcome" });
        return;
      }
      if (!heldTurn) {
        send(409, { error: "No turn is held" });
        return;
      }
      const answer = heldTurn;
      heldTurn = undefined;
      answer(outcome);
      response.writeHead(204).end();
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
        const answer = (content: string) =>
          send(200, {
            choices: [{ message: { role: "assistant", content } }],
            usage: { prompt_tokens: 32, completion_tokens: 16 }
          });
        if (observation && holdArmed) {
          holdArmed = false;
          heldTurn = (outcome) =>
            outcome === "success"
              ? answer(MEETING_FIXTURE_LATE_REPLY)
              : send(500, { error: { message: "Synthetic held turn failure" } });
          return;
        }
        answer(
          observation?.hasNotes
            ? "The synthetic decision is recorded in the personal notes."
            : MEETING_FIXTURE_REPLY
        );
      } catch {
        send(400, { error: "Invalid fixture request" });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    stop: () => {
      // A held turn keeps its connection open, which would stall close.
      heldTurn?.("failure");
      heldTurn = undefined;
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}
