// Runs tests/live/integrations-2162-uat.spec.ts against its own disposable stack (#3279):
// provisions a solo-admin install on the claimed web port with the real Codex login copied in,
// signs in as the seeded admin, and tears the stack down afterwards. The external services
// (LIVE_HA_*, LIVE_RADARR_*) pass through from the operator's environment.
//
//   JARVIS_UAT_CLAIMED_WEB_PORT=<devports claim> LIVE_RADARR_URL=... \
//     pnpm test:uat:2162-live [playwright args]
import { spawn } from "node:child_process";

import { captureFailureEvidence, provisionForUat } from "./provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "./seed/admin.js";

const SPEC = "tests/live/integrations-2162-uat.spec.ts";

function readClaimedWebPort(): number {
  const raw = process.env.JARVIS_UAT_CLAIMED_WEB_PORT ?? "";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
    throw new Error("set JARVIS_UAT_CLAIMED_WEB_PORT to a port from `devports claim`");
  }
  return port;
}

async function main(): Promise<number> {
  const claimedWebPort = readClaimedWebPort();
  const { baseURL, projectName, teardown } = await provisionForUat("solo-admin", {
    claimedWebPort
  });
  const onSignal = () => {
    void teardown().finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    console.log(`[uat] running ${SPEC} against ${baseURL} (project ${projectName})`);
    // Traces record typed credentials, so they stay off.
    const exitCode = await new Promise<number>((resolvePromise) => {
      const child = spawn(
        "npx",
        [
          "playwright",
          "test",
          "--config=playwright.live.config.ts",
          "--trace=off",
          SPEC,
          ...process.argv.slice(2)
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            LIVE_BASE_URL: baseURL,
            LIVE_OWNER_EMAIL: UAT_ADMIN_EMAIL,
            LIVE_OWNER_PASSWORD: UAT_ADMIN_PASSWORD,
            JARVIS_UAT_BASE_URL: baseURL,
            JARVIS_UAT_PROJECT_NAME: projectName
          }
        }
      );
      child.on("exit", (code) => resolvePromise(code ?? 1));
    });
    if (exitCode !== 0) {
      await captureFailureEvidence(projectName, `spec ${SPEC} failed (exit ${exitCode})`);
    }
    return exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await teardown();
  }
}

process.exit(await main());
