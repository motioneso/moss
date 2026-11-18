import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const target = process.env.CARGO_TARGET_DIR ?? "/tmp/js48-host-target";
const run = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--locked",
    "--offline",
    "--manifest-path",
    "modules/calendar/host/Cargo.toml",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: target,
      CALENDAR_CORE_WASM: `${target}/calendar-guest/wasm32-unknown-unknown/release/moss_calendar.wasm`,
      JS48_APP_URL: urls.app,
      JS48_BOOTSTRAP_URL: urls.bootstrap
    }
  }
);
process.exit(run.status ?? 1);
