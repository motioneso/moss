import { spawnSync } from "node:child_process";
import { negativeControls } from "./phase6-local-controls.js";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
if (!process.env.CARGO_TARGET_DIR || !process.env.RUSTUP_HOME) {
  throw new Error("Use an isolated CARGO_TARGET_DIR and explicit RUSTUP_HOME");
}
const urls = getMossDatabaseUrls();
const env = {
  ...process.env,
  CARGO_BUILD_JOBS: "2",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  JS43_APP_URL: urls.app,
  JS43_WORKER_URL: urls.worker,
  JS43_BOOTSTRAP_URL: urls.bootstrap
};
negativeControls(env);
// The restored host must pass the complete installed-host suite after every control.
const result = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "phase6_local_isolation",
    "--",
    "--include-ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  { stdio: "inherit", env }
);
if (result.status !== 0) process.exit(result.status ?? 1);
const trust = spawnSync(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "phase6_local_trust",
    "--",
    "--nocapture",
    "--test-threads=1"
  ],
  { stdio: "inherit", env }
);
process.exit(trust.status ?? 1);
