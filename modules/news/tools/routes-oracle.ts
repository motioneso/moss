/** The old News choice, personalization and topic routes on the disposable gate database. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { registerNewsRoutes } from "../../../packages/news/src/routes.js";

type Step = { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; body?: unknown };

/** No provider data: every dataset answers with its fallback and the degraded flag. */
const outage = {
  getDataset: async (_key: string, _params: unknown, options: { fallback?: unknown }) => ({
    data: options.fallback ?? null,
    degraded: true,
    cacheMiss: false
  })
};

/** The Rust package has no web search, so the old routes run with it off. A model is present. */
const unavailable = {
  hasJsonModel: async () => true,
  hasWebSearch: async () => false,
  webSearchReason: async () => "no-key-no-native-model" as const
};

/** The one fixture site the Rust side serves too. Any other address fails as a network error. */
const site: Record<string, { type: string; body: string }> = {
  "https://daily.sample.test/": {
    type: "text/html",
    body: '<html><head><title>Sample Daily</title><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>'
  },
  "https://daily.sample.test/feed.xml": {
    type: "application/rss+xml",
    body: "<rss><channel><title>x</title><item><title>First story here</title><link>https://daily.sample.test/1</link></item></channel></rss>"
  }
};
const read = async (url: string) => {
  const page = site[url];
  return page
    ? {
        ok: true as const,
        status: 200,
        finalUrl: url,
        hopCount: 0,
        contentType: page.type,
        body: page.body,
        truncated: false
      }
    : { ok: false as const, reason: "network" as const };
};
const discovery = {
  fetch: read,
  fetchWithOptions: read,
  search: {
    search: async () => {
      throw new Error("The Rust package has no web search, so the oracle must never use it");
    }
  },
  ai: {
    fingerprint: async () => "host-ai-v1",
    generateJson: async () => ({
      ok: true as const,
      object: { allowed: true, category: "news_publisher" }
    })
  }
};

export async function routesOracle(
  actor: string,
  steps: readonly Step[],
  vars: Readonly<Record<string, string>> = {}
) {
  assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
  const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
  const server = Fastify();
  setMossErrorHandler(server);
  registerNewsRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "news-parity" }),
    dataContext: new DataContextRunner(db),
    datasetClient: outage as never,
    availability: unavailable,
    discovery: discovery as never,
    boss: null,
    resolveCredentialCipher: async () => null
  });
  try {
    const responses = [];
    // A preview's confirmation id fills `{conf}` in later steps of the same run.
    const known: Record<string, string> = { ...vars };
    const fill = (text: string) =>
      text.replace(/\{(\w+)\}/g, (_m, name: string) => known[name] ?? _m);
    for (const { method, url: template, body } of steps) {
      const result = await server.inject({
        method,
        url: fill(template),
        ...(body === undefined
          ? {}
          : {
              payload: fill(JSON.stringify(body)),
              headers: { "content-type": "application/json" }
            })
      });
      const answer = result.json() as { confirmationId?: unknown };
      if (typeof answer.confirmationId === "string") known.conf = answer.confirmationId;
      responses.push({ status: result.statusCode, body: answer as unknown });
    }
    return { responses };
  } finally {
    await server.close();
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith("routes-oracle.ts")) {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const { actor, steps, vars }: { actor: string; steps: Step[]; vars?: Record<string, string> } =
    JSON.parse(input);
  console.log(JSON.stringify(await routesOracle(actor, steps, vars)));
}
