/**
 * The old Sports catalog, league team and club search routes, run through the old Fastify
 * handlers with the real dataset client and ESPN reader. Only the network is replaced: each
 * league answers from a recorded fixture. Run: tsx tools/public-oracle.ts > tests/fixtures/public-routes.golden.json
 */
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { createDatasetClient } from "../../../packages/datasets/src/index.js";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { createEspnDatasetAdapter } from "../../../packages/sports/src/source/espn-source.js";
import { sportsModuleManifest } from "../../../packages/sports/src/manifest.js";
import { registerSportsRoutes } from "../../../packages/sports/src/routes.js";
import { steps } from "../tests/fixtures/public-steps.js";

const dir = new URL("../tests/fixtures/", import.meta.url);
const fixtureFor = (url: string): string => {
  if (url.includes("/soccer/eng.1/")) return "eng1-teams.json";
  if (url.includes("/baseball/college-baseball/")) return "ncaa-baseball-teams-subset.json";
  return "nfl-teams.json";
};
const fetchFn = (async (url: string) => {
  const body = readFileSync(new URL(fixtureFor(String(url)), dir), "utf8");
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const [source] = sportsModuleManifest.externalSources ?? [];
if (!source) throw new Error("missing espn source");
const datasetClient = createDatasetClient(source, createEspnDatasetAdapter(), { fetchFn });
const server = Fastify();
setMossErrorHandler(server);
registerSportsRoutes(server, {
  resolveAccessContext: async () => ({
    actorUserId: "00000000-0000-4000-8000-00000000000a",
    requestId: "parity"
  }),
  dataContext: {} as never,
  datasetClient,
  discovery: {} as never,
  storyFeedback: {} as never
});
const responses = [];
for (const url of steps) {
  const result = await server.inject({ method: "GET", url });
  responses.push({ url, status: result.statusCode, body: result.json() as unknown });
}
await server.close();
console.log(JSON.stringify(responses, null, 1));
