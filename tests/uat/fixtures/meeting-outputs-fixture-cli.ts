import { startMeetingOutputsFixtureServer } from "./meeting-outputs-fixture-server.js";
const server = await startMeetingOutputsFixtureServer();
console.log("[meeting-outputs-fixture] ready");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
