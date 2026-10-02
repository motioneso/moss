// tests/uat/fixtures/classifier-fixture-server.ts
//
// #2907 (plan 3.5) live-path proof support: a deterministic stand-in for the configured chat
// classifier. The gate asks an `openai-compatible` JSON model choice questions ("which area",
// "which tool", "which value"); this origin answers each with a valid choice object so the shadow
// attempt records a real `would_handle` decision that can be compared with the default model's
// first tool call.
//
// Deliberately TEST-ONLY. It is never referenced by production configuration or source; the UAT
// provisioner starts it as a container on the ephemeral Compose network and the UAT seed points a
// provider at it. Absent the fixture, no classifier is configured and the gate declines.
//
// The answer is derived only from the request's `response_format.json_schema.schema`, so it is
// deterministic and independent of prompt prose. Options are preferred in the order the first-party
// calendar path needs (area -> tool -> window); anything unrecognized picks the first non-sentinel
// option, and a non-choice schema gets an explicit 400 so a wrong request fails loudly here.
import { createServer, type Server } from "node:http";

/** Private to the Compose network; distinct from the job-search (8080) and writer (8081) origins. */
export const CLASSIFIER_FIXTURE_CONTAINER_PORT = 8082;

const SENTINELS = new Set(["none", "needs_earlier_conversation", "none_of_these", "other"]);
const PREFERRED = ["calendar", "calendar.listVisibleEvents", "today"] as const;

interface ChoiceSchema {
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Picks the answer the calendar shadow path needs, falling back to the first real option. */
export function chooseFixtureOption(options: readonly string[]): string {
  for (const preferred of PREFERRED) {
    if (options.includes(preferred)) return preferred;
  }
  return options.find((option) => !SENTINELS.has(option)) ?? options[0]!;
}

/**
 * Builds a choice object for the schema the caller asked for. `scores` must name every option and
 * the chosen option must hold the top score, so the runner-up margin clears the gate's lead bar.
 */
export function buildChoiceObject(options: readonly string[]): Record<string, unknown> | null {
  if (options.length < 2) return null;
  const target = chooseFixtureOption(options);
  const rest = options.filter((option) => option !== target);
  const scores: Record<string, number> = {};
  const confidence = 0.99;
  const remainder = (1 - confidence) / rest.length;
  for (const option of rest) scores[option] = remainder;
  scores[target] = confidence;
  return { choice: target, confidence, scores };
}

/**
 * A fixed answer shaped to satisfy the product adapter's `openai-compatible` structured case
 * (`packages/ai/src/adapters/http-api-structured.ts`): `choices[0].message.content` carries the
 * JSON object. Exported pure so a unit test pins the wire shape without a port.
 */
export function buildClassifierFixtureResponse(requestBodyText: string): {
  readonly status: number;
  readonly body: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBodyText);
  } catch (error) {
    return {
      status: 400,
      body: JSON.stringify({
        error: `classifier fixture: invalid JSON body: ${String(error)}`
      })
    };
  }
  const schema = isRecord(parsed)
    ? ((parsed["response_format"] as { json_schema?: { schema?: ChoiceSchema } } | undefined)
        ?.json_schema?.schema as ChoiceSchema | undefined)
    : undefined;
  const choiceProperty = isRecord(schema?.properties?.choice)
    ? schema.properties.choice
    : undefined;
  const options = Array.isArray(choiceProperty?.["enum"])
    ? (choiceProperty["enum"] as unknown[]).filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const object = buildChoiceObject(options);
  if (!object) {
    return {
      status: 400,
      body: JSON.stringify({ error: "classifier fixture: request schema is not a choice question" })
    };
  }
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(object) } }],
      usage: { prompt_tokens: 32, completion_tokens: 16 }
    })
  };
}

export interface ClassifierFixtureServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

/** Starts the fixture origin and resolves once it is actually listening. */
export async function startClassifierFixtureServer(
  options: { readonly host?: string; readonly port?: number } = {}
): Promise<ClassifierFixtureServer> {
  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 0;

  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const { status, body } = buildClassifierFixtureResponse(
          Buffer.concat(chunks).toString("utf8")
        );
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(body);
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`classifier fixture: no route for ${pathname}`);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolvePromise());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("classifier fixture: expected an AddressInfo after listen()");
  }

  return {
    port: address.port,
    baseUrl: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
    stop: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      })
  };
}
