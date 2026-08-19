// tests/uat/fixtures/job-search-fixture-server.ts
//
// #1306 Task 22: the deterministic origin the UAT run points the job-search module's crawl at,
// via the host-side createFetch bypass in apps/worker/src/external-module-job-handler.ts. The
// test must not touch LinkedIn or freehire.me — a live portal makes this fail on someone else's
// Cloudflare rule at 3am (see the Task 22 handoff doc's "fetch ruling"). This server answers with
// Task 11's saved captures (tests/fixtures/job-search/*) instead.
//
// N42 (rulings-ledger.md#n42): this same origin ALSO stands in for the scoring stage's AI
// provider — a POST /v1/chat/completions route below, shaped like the real
// `openai-compatible` HTTP contract (packages/ai/src/adapters/http-api-structured.ts). UAT seeds
// a fake `openai-compatible` provider/model bound to `module.job-search` pointed at this same
// base URL (tests/uat/seed/chunks/job-search-ai.ts) rather than gating the whole spec behind a
// real Anthropic token — scoring is exercised for real, token-free.
//
// Binds on all interfaces (default host "0.0.0.0"), not just loopback: in a UAT run this server
// is a container on the stack's own Compose network (see fixture-server-cli.ts), and the crawl
// (plus, per N42, the scoring HTTP call) reaches it by container name from the `jarv1s` worker.
// The provisioner (provisioner.ts) owns the reachable base URL it publishes as
// JARVIS_E2E_MODULE_FETCH_BASE (crawl) and JARVIS_UAT_JOB_SEARCH_AI_BASE_URL (scoring). This
// module has no opinion about that; it only binds wide enough to be reachable once pointed at.
//
// It deliberately does NOT run on the host any more. The first live run of the board UAT proved
// why: a host process is reachable from a container only via the Docker bridge gateway address,
// and on any host running ufw (this project's dev box included) the gateway address is an INPUT
// drop — every crawl fetch timed out and the board sat empty with `kind: "network"` degradations.
// Same-network container-to-container traffic crosses no host firewall at all.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/uat/fixtures -> tests/fixtures/job-search
const FIXTURE_DIR = join(HERE, "..", "..", "fixtures", "job-search");

interface FixtureRoute {
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * Path-keyed static route table. Matched on `pathname` only — `createE2eFixtureFetch` rewrites
 * the full `pathname + search` from the real target URL onto this server's origin, and the real
 * adapters vary their query string per page/criteria (see freehire.ts's `buildUrl` and
 * linkedin.ts's), so a query-sensitive match would 404 on every request but the first.
 *
 * The LinkedIn route deliberately serves the synthetic auth-wall capture, not the real
 * `linkedin-guest.html` happy-path capture — permanently, for every UAT run that starts this
 * server. Job-search-board.uat.spec.ts's Phase 8 needs a degraded portal it can rely on from the
 * very first crawl, and a fixture server has no per-test hook to vary its own responses mid-run
 * (Playwright drives the real browser against the real stack, not this process). freehire remains
 * the sole happy-path source in UAT; LinkedIn is always `login_required`/disabled here. See
 * `tests/fixtures/job-search/linkedin-authwall.html`'s header for why this body, not a live
 * capture, exercises the wall.
 *
 * freehire serves `freehire-data-uat-overflow.json`, a DIFFERENT file from
 * `freehire-data.json` — deliberately not the plain Task 11 capture. That file is shared with
 * `tests/unit/job-search-adapter-freehire.test.ts`, which hard-asserts `toHaveLength(3)` against
 * it; inflating it in place would silently break that suite. This UAT-only sibling has the same 3
 * postings plus 7 synthetic ones, which is enough rows for the board to look like a board —
 * sorting, the Inspector, a dismissal — rather than a three-line list.
 *
 * It used to carry a second job: 10 postings against an `AI_CALL_BUDGET` of 8 guaranteed a couple
 * of rows the scoring stage never reached, which is how the board spec got an unscored row to
 * assert #1329's "queued, not dropped" contract against. The budget is 200 now, so ten postings
 * overflow nothing; that spec's Phase 9 seeds its unscored row directly instead. Do not re-derive
 * any assertion from this file's length against a budget constant.
 */
function buildRoutes(): ReadonlyMap<string, FixtureRoute> {
  return new Map<string, FixtureRoute>([
    // Matches freehire.ts's BASE_URL ("https://freehire.me/__data.json") pathname exactly.
    [
      "/__data.json",
      {
        contentType: "application/json; charset=utf-8",
        body: readFileSync(join(FIXTURE_DIR, "freehire-data-uat-overflow.json"))
      }
    ],
    // Matches linkedin.ts's BASE_URL
    // ("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search") pathname exactly.
    [
      "/jobs-guest/jobs/api/seeMoreJobPostings/search",
      {
        contentType: "text/html; charset=utf-8",
        body: readFileSync(join(FIXTURE_DIR, "linkedin-authwall.html"))
      }
    ]
  ]);
}

/**
 * N42: FNV-1a, same hash family this codebase already uses for chat-surface ids (see
 * chat-surface-pattern-trap memory — FNV, never sha256, for a cheap deterministic digest with no
 * crypto dependency). 32-bit is plenty of spread for a handful of fixture postings.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * N42: a real model would score each posting differently; this fixture must too, or Phase 7's
 * sort-order assertions (fit descending) would have nothing to sort. `title` is the one durable
 * identifier a UAT spec can key its expectations off without re-deriving this hash — export it
 * so job-search-board.uat.spec.ts computes its expected fit/want the same way, from the same
 * fixture titles, instead of hardcoding numbers that would silently drift the moment this
 * function changes. Range is deliberately narrow (55-94) and axis-salted so fit and want differ
 * per posting without ever colliding at the same value for both axes on the same title.
 */
export function deterministicFixtureScore(title: string, axis: "fit" | "want"): number {
  return 55 + (fnv1a(`${title}:${axis}`) % 40);
}

/**
 * N42: pulls the one identifying line buildScorePrompt (external-modules/job-search/src/domain/
 * score.ts) always emits right after the "--- POSTING ---" marker —
 * "<title> at <company> — <location>" — so this fixture can score consistently per-posting
 * without parsing the rest of the prompt. Falls back to the whole prompt text if the marker is
 * ever missing (a schema/prompt-shape drift upstream), so a malformed request still gets a
 * deterministic answer instead of throwing.
 */
function extractPostingTitle(promptText: string): string {
  const match = promptText.match(/--- POSTING ---\n(.+) at .+ — .+/);
  return match ? match[1]! : promptText;
}

interface ChatCompletionsRequestBody {
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: string }>;
}

/**
 * N42: shaped to satisfy extractStructuredResult's "openai-compatible" case
 * (packages/ai/src/adapters/http-api-structured.ts) — `choices[0].message.content` must be a
 * JSON-stringified object matching SCORE_SCHEMA exactly
 * (fit/fitDisposition/want/fitReason/wantReason, no extra fields), and
 * `usage.{prompt_tokens,completion_tokens}` must both be present.
 */
export function buildChatCompletionsResponse(requestBodyText: string): {
  readonly status: number;
  readonly body: string;
} {
  let parsed: ChatCompletionsRequestBody;
  try {
    parsed = JSON.parse(requestBodyText) as ChatCompletionsRequestBody;
  } catch (error) {
    return {
      status: 400,
      body: JSON.stringify({
        error: `job-search fixture server: invalid JSON body: ${String(error)}`
      })
    };
  }
  const promptText = parsed.messages?.map((message) => message.content ?? "").join("\n") ?? "";
  const title = extractPostingTitle(promptText);
  const fit = deterministicFixtureScore(title, "fit");
  const want = deterministicFixtureScore(title, "want");
  const scoreObject = {
    fit,
    fitDisposition: "supported",
    want,
    fitReason: `UAT fixture: deterministic fit score derived from the posting title "${title}".`,
    wantReason: `UAT fixture: deterministic want score derived from the posting title "${title}".`
  };
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify(scoreObject) } }],
      usage: { prompt_tokens: promptText.length, completion_tokens: 64 }
    })
  };
}

/**
 * The port fixture-server-cli.ts listens on inside its container, and therefore the port the
 * provisioner writes into the stack's base URLs. Private to the Compose network — nothing
 * publishes it to the host — so it only has to avoid colliding with the fixture container's own
 * ports, of which there are none.
 */
export const JOB_SEARCH_FIXTURE_CONTAINER_PORT = 8080;

export interface JobSearchFixtureServer {
  readonly port: number;
  /** Base URL as seen from THIS host/process. A caller whose consumer lives somewhere else (a
   *  container on a Compose network, say) must build that URL itself from the routable name. */
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

/**
 * Starts the fixture origin and resolves once it is actually listening. Defaults to an
 * OS-assigned ephemeral port (`listen(0, host)`), which is what the in-process unit test wants —
 * nothing else has to guess the port ahead of time.
 *
 * `options.port` pins it instead. The UAT harness runs this inside a container on the stack's own
 * Compose network (fixture-server-cli.ts), where the port is private to that network and a fixed,
 * predictable number lets the provisioner write the base URL into the stack's env BEFORE the
 * fixture container is started.
 *
 * Any request outside the two known paths gets a 404 with a body naming the path, not a silent
 * empty 200 — a typo'd adapter path should fail loudly here, not read back as "zero postings
 * found."
 */
export async function startJobSearchFixtureServer(
  options: { readonly host?: string; readonly port?: number } = {}
): Promise<JobSearchFixtureServer> {
  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 0;
  const routes = buildRoutes();

  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://fixture.invalid").pathname;

    // N42: dynamic (per-request-body) route, kept out of buildRoutes()'s static Map — every other
    // route ignores the request body/method entirely, but a scoring response has to vary by
    // posting to be useful for a sort-order assertion, so this one has to read the body first.
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const { status, body } = buildChatCompletionsResponse(
          Buffer.concat(chunks).toString("utf8")
        );
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(body);
      });
      return;
    }

    const route = routes.get(pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`job-search fixture server: no route for ${pathname}`);
      return;
    }
    res.writeHead(200, { "content-type": route.contentType });
    res.end(route.body);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolvePromise());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("job-search fixture server: expected an AddressInfo after listen()");
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
