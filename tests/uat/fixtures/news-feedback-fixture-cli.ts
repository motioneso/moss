import {
  NEWS_FEEDBACK_FIXTURE_PORT,
  startNewsFeedbackFixtureServer
} from "./news-feedback-fixture-server.js";
const fixture = await startNewsFeedbackFixtureServer(NEWS_FEEDBACK_FIXTURE_PORT);
console.log(`[news-feedback-fixture] listening on ${fixture.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void fixture.stop().then(() => process.exit(0));
  });
