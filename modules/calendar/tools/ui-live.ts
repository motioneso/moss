import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const result = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "run",
    "--locked",
    "--offline",
    "--manifest-path",
    "modules/calendar/host/Cargo.toml",
    "--example",
    "ui_check"
  ],
  {
    stdio: "inherit",
    env: { ...process.env, JS48_APP_URL: urls.app, JS48_BOOTSTRAP_URL: urls.bootstrap }
  }
);
process.exit(result.status ?? 1);
