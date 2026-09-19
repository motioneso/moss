// tests/uat/fixtures/briefing-writer-fixture-cli.ts
//
// [task:p8-briefing-writer-unreachable]: container entrypoint for the briefing-writer fixture
// origin. The UAT provisioner runs this as a plain `docker run -d` attached to the stack's
// Compose network, using the same image the stack itself runs (which already ships `tests/`
// and `node_modules/.bin/tsx` — that is how the `seed` and `module-install` ops services run
// repo TypeScript in-network). See fixture-server-cli.ts for the shape this mirrors and for
// why the origin lives in-network rather than on the host (ufw drops the bridge-gateway
// route).
//
// The port is fixed rather than OS-assigned. It is private to the Compose network (nothing is
// published to the host), so there is no conflict to avoid, and a predictable number lets the
// provisioner write the base URL into the stack's env before this container exists. It is 8081,
// not the job-search fixture's 8080, so the two origins never share fate on one port.
import {
  BRIEFING_WRITER_FIXTURE_CONTAINER_PORT,
  startBriefingWriterFixtureServer
} from "./briefing-writer-fixture-server.js";

const server = await startBriefingWriterFixtureServer({
  port: BRIEFING_WRITER_FIXTURE_CONTAINER_PORT
});

// The provisioner polls `docker logs` for this exact line to know the origin is accepting
// connections — printed only after listen() has resolved, so it is a real readiness signal and
// not just "the process started".
console.log(`[briefing-writer-fixture] listening on ${server.port}`);

// Stay alive until the provisioner removes the container. Without an explicit handler, SIGTERM
// from `docker rm -f` would kill the process without closing the server; closing it first means a
// clean exit code in the container's status, so a genuinely crashed fixture is distinguishable
// from a deliberately torn-down one.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
