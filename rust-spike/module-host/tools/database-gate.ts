import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const run = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "database",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      JS43_APP_URL: urls.app,
      JS43_WORKER_URL: urls.worker,
      JS43_MIGRATION_URL: urls.migration,
      JS43_BOOTSTRAP_URL: urls.bootstrap
    }
  }
);
process.exit(run.status ?? 1);
