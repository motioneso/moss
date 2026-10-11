// Runs tests/live/integrations-2162-uat.spec.ts against its own disposable stack (#3279):
// a solo-admin install on the claimed web port with a real chat sign-in, signed in as the seeded
// admin. JARVIS_UAT_REAL_CHAT_PROVIDER picks the sign-in (real-chat-env.ts): the host Codex login
// by default, or Claude through Moss's own sign-in link. The external services (LIVE_HA_*,
// LIVE_RADARR_*) pass through from the operator's environment.
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
  // Traces and screenshots record typed credentials and sign-in codes, so both stay off.
  args: ["--config=playwright.live.config.ts", "--trace=off", SPEC, ...process.argv.slice(2)],
  env: {
    ...process.env,
    LIVE_BASE_URL: baseURL,
    LIVE_OWNER_EMAIL: UAT_ADMIN_EMAIL,
    LIVE_OWNER_PASSWORD: UAT_ADMIN_PASSWORD,
    LIVE_BIND_CHEAPEST_MODEL: "1",
    MOSS_UAT_CAPTURE_OFF: "1",
    JARVIS_UAT_BASE_URL: baseURL,
    JARVIS_UAT_PROJECT_NAME: projectName
  }
}));
process.exit(exitCode);
