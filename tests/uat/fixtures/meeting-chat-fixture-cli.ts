import { startMeetingChatFixtureServer } from "./meeting-chat-fixture-server.js";

const server = await startMeetingChatFixtureServer();
console.log("[meeting-chat-fixture] ready");
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
