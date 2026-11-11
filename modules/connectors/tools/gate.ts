import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const run = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--offline",
    "--manifest-path",
    "modules/connectors/host/Cargo.toml",
    "--test",
    "db",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: "inherit",
    env: { ...process.env, JS48_APP_URL: urls.app, JS48_BOOTSTRAP_URL: urls.bootstrap }
  }
);
process.exit(run.status ?? 1);
