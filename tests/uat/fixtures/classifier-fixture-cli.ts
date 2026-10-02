// tests/uat/fixtures/classifier-fixture-cli.ts
//
// #2907 (plan 3.5): container entrypoint for the classifier fixture origin. The provisioner runs
// this as a plain `docker run -d` on the stack's Compose network, using the same image the stack
// runs (which ships `tests/` and `node_modules/.bin/tsx`). Mirrors
// `briefing-writer-fixture-cli.ts`.
import {
  CLASSIFIER_FIXTURE_CONTAINER_PORT,
  startClassifierFixtureServer
} from "./classifier-fixture-server.js";

const server = await startClassifierFixtureServer({ port: CLASSIFIER_FIXTURE_CONTAINER_PORT });

// The provisioner polls `docker logs` for this exact line as a readiness signal.
console.log(`[classifier-fixture] listening on ${server.port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
