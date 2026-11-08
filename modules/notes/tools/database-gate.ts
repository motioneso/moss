import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const run = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "linked_notes_database",
    "--test",
    "notes_privacy",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      JS47_APP_URL: urls.app,
      JS47_WORKER_URL: urls.worker,
      JS47_BOOTSTRAP_URL: urls.bootstrap
    }
  }
);
process.exit(run.status ?? 1);
