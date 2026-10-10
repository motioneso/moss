// Runs tests/live/integrations-2162-uat.spec.ts against its own disposable stack (#3279):
// a solo-admin install on the claimed web port with the real Codex login copied in, signed in as
// the seeded admin. The external services (LIVE_HA_*, LIVE_RADARR_*) pass through from the
// operator's environment.
//
//   JARVIS_UAT_CLAIMED_WEB_PORT=<devports claim> LIVE_RADARR_URL=... \
//     pnpm test:uat:2162-live [playwright args]
import { readClaimedWebPort, runPlaywrightOnStack } from "./provisioned-run.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "./seed/admin.js";

const SPEC = "tests/live/integrations-2162-uat.spec.ts";

if (readClaimedWebPort() === undefined) {
  throw new Error("set JARVIS_UAT_CLAIMED_WEB_PORT to a port from `devports claim`");
}

const exitCode = await runPlaywrightOnStack("solo-admin", {}, SPEC, ({ baseURL, projectName }) => ({
  // Traces record typed credentials, so they stay off.
  args: ["--config=playwright.live.config.ts", "--trace=off", SPEC, ...process.argv.slice(2)],
  env: {
    ...process.env,
    LIVE_BASE_URL: baseURL,
    LIVE_OWNER_EMAIL: UAT_ADMIN_EMAIL,
    LIVE_OWNER_PASSWORD: UAT_ADMIN_PASSWORD,
    LIVE_BIND_CHEAPEST_MODEL: "1",
    JARVIS_UAT_BASE_URL: baseURL,
    JARVIS_UAT_PROJECT_NAME: projectName
  }
}));
process.exit(exitCode);
