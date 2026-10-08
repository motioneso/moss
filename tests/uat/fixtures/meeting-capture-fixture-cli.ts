import { startMeetingCaptureFixtureServer } from "./meeting-capture-fixture-server.js";
const server = await startMeetingCaptureFixtureServer();
console.log("[meeting-capture-fixture] ready; generated PCM only");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
