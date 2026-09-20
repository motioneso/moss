// tests/uat/fixtures/briefing-writer-fixture-server.ts
//
// [task:p8-briefing-writer-unreachable]: the fixed stand-in writer for briefing
// synthesis in UAT. Briefing compose (packages/briefings/src/compose-shared.ts's
// synthesizeWithConfiguredModel) picks the user's economy `summarization` model and runs one
// generateChat call against it; the UAT seed never creates such a model, so synthesis returns
// `no_model` and every briefing card renders the degraded fallback dump. This server answers
// POST /v1/chat/completions with the same fixed prose for every request, and the seed chunk
// (tests/uat/seed/chunks/briefing-writer-ai.ts) points a real `openai-compatible` provider at
// it — same shape as the job-search fixture (tests/uat/fixtures/job-search-fixture-server.ts:
// real baseUrl, fake key), but a separate origin on its own port, because its answer contract
// is fixed prose, not per-posting score JSON.
//
// The prose is one fixed string, deliberately neutral about time of day so the same answer
// serves the morning and the evening path. No timestamps, no ids, no counters, nothing derived
// from the request: anything run-derived here would make two captures of the same card differ
// for no product reason, which is exactly what this fixture exists to prevent.
//
// Binds on all interfaces (default host "0.0.0.0"), not just loopback: in a UAT run this server
// is a container on the stack's own Compose network (see briefing-writer-fixture-cli.ts), and
// the worker's synthesis HTTP call reaches it by container name. Same-network
// container-to-container traffic crosses no host firewall at all — see
// job-search-fixture-server.ts's header for the live ufw failure behind this rule.
import { createServer, type Server } from "node:http";

/**
 * The whole answer, every run. A headline sentence and a short paragraph, shaped like the
 * approved briefing openings: one line that says what kind of day it is, then what is on it.
 */
export const BRIEFING_WRITER_HEADLINE = "A steady day with room for deep work.";

export const BRIEFING_WRITER_PARAGRAPH =
  "Your calendar holds three focused blocks with clear breaks between them. " +
  "Two commitments carry over from yesterday, and everything else can wait until after " +
  "the first meeting. Nothing needs your attention before then.";

export const BRIEFING_WRITER_PROSE = `${BRIEFING_WRITER_HEADLINE}\n\n${BRIEFING_WRITER_PARAGRAPH}`;

interface ChatCompletionsRequestBody {
  readonly model?: string;
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: string }>;
}

/**
 * Fixed chat-completions answer shaped to satisfy the product adapter's "openai-compatible"
 * case (packages/ai/src/adapters/http-api.ts): `choices[0].message.content` carries the prose.
 * The request body is parsed (malformed JSON 400s) but otherwise ignored — the same request
 * must get the same answer on every run, and the simplest way to guarantee that is to not
 * read the request at all. Exported pure so the unit test pins the wire shape without a port.
 */
export function buildBriefingWriterResponse(requestBodyText: string): {
  readonly status: number;
  readonly body: string;
} {
  try {
    JSON.parse(requestBodyText) as ChatCompletionsRequestBody;
  } catch (error) {
    return {
      status: 400,
      body: JSON.stringify({
        error: `briefing-writer fixture server: invalid JSON body: ${String(error)}`
      })
    };
  }
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { role: "assistant", content: BRIEFING_WRITER_PROSE } }],
      usage: { prompt_tokens: 128, completion_tokens: 64 }
    })
  };
}

/**
 * The port briefing-writer-fixture-cli.ts listens on inside its container, and therefore the
 * port the provisioner writes into the stack's base URLs. Private to the Compose network —
 * nothing publishes it to the host — and distinct from the job-search fixture's 8080 so the
 * two origins never share fate on one port.
 */
export const BRIEFING_WRITER_FIXTURE_CONTAINER_PORT = 8081;

export interface BriefingWriterFixtureServer {
  readonly port: number;
  /** Base URL as seen from THIS host/process. A caller whose consumer lives somewhere else (a
   *  container on a Compose network, say) must build that URL itself from the routable name. */
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

/**
 * Starts the fixture origin and resolves once it is actually listening. Defaults to an
 * OS-assigned ephemeral port (`listen(0, host)`), which is what the in-process unit test wants.
 * `options.port` pins it instead, for the container on the Compose network.
 *
 * Any request outside POST /v1/chat/completions gets a 404 with a body naming the path, not a
 * silent empty 200 — a typo'd adapter path should fail loudly here, not read back as prose.
 */
export async function startBriefingWriterFixtureServer(
  options: { readonly host?: string; readonly port?: number } = {}
): Promise<BriefingWriterFixtureServer> {
  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 0;

  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://fixture.invalid").pathname;

    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const { status, body } = buildBriefingWriterResponse(
          Buffer.concat(chunks).toString("utf8")
        );
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(body);
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`briefing-writer fixture server: no route for ${pathname}`);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolvePromise());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("briefing-writer fixture server: expected an AddressInfo after listen()");
  }
  const { port } = address;

  return {
    port,
    baseUrl: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    stop: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      })
  };
}
