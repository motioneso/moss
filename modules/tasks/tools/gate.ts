import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env["JARVIS_GATE_RUN"] !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const run = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--locked",
    "--offline",
    "--manifest-path",
    "modules/tasks/tools/Cargo.toml",
    "--test",
    "privacy",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      JS51_APP_URL: urls.app,
      JS51_BOOTSTRAP_URL: urls.bootstrap
    }
  }
);
if (run.status !== 0) process.exit(run.status ?? 1);
const tools = spawnSync("pnpm", ["exec", "tsx", "modules/tasks/tools/tool-parity.ts"], {
  stdio: "inherit",
  env: process.env
});
if (tools.status !== 0) process.exit(tools.status ?? 1);
const appMap = spawnSync("pnpm", ["build:app-map"], {
  stdio: "inherit",
  env: process.env
});
if (appMap.status !== 0) process.exit(appMap.status ?? 1);
const legacy = spawnSync(
  "pnpm",
  ["exec", "tsx", "scripts/test-integration.ts", "tests/integration/tasks.test.ts"],
  { stdio: "inherit", env: process.env }
);
process.exit(legacy.status ?? 1);
