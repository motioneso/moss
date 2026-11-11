import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const checks = spawnSync("modules/connectors/tools/check.sh", {
  stdio: "inherit",
  env: process.env
});
if (checks.status !== 0) process.exit(checks.status ?? 1);
const target = process.env.CARGO_TARGET_DIR ?? "/tmp/moss-connectors-host";
const wasm = `${target}/connectors-guest/wasm32-unknown-unknown/release/moss_connectors.wasm`;
const run = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--locked",
    "--offline",
    "--manifest-path",
    "modules/connectors/host/Cargo.toml",
    "--test",
    "db",
    "--test",
    "google",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      JS48_APP_URL: urls.app,
      JS48_BOOTSTRAP_URL: urls.bootstrap,
      CONNECTORS_CORE_WASM: wasm
    }
  }
);
process.exit(run.status ?? 1);
