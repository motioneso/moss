// tests/uat/fixtures/classifier-mcp-fixture-cli.ts
//
// Plan 2b.6 (#2936): container entrypoint for the classifier tool-server fixture. Same shape as
// briefing-writer-fixture-cli.ts: a detached container on the stack's Compose network, running
// the stack's own image, with a readiness line the provisioner waits for.
import {
  CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT,
  startClassifierMcpFixtureServer
} from "./classifier-mcp-fixture-server.js";

const server = await startClassifierMcpFixtureServer({
  port: CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT
});

console.log(`[classifier-mcp-fixture] listening on ${server.port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
