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
process.exit(run.status ?? 1);
