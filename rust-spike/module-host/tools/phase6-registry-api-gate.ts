import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR"]) {
  if (!process.env[name]) throw new Error(`Use task-owned ${name}`);
}
const urls = getMossDatabaseUrls();
function cargo(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync("cargo", ["+1.95.0", ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_BUILD_JOBS: "1",
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      ...extra
    }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!process.env.JS414_SERVER)
  cargo([
    "build",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/shell/Cargo.toml",
    "-p",
    "moss-shell"
  ]);
cargo([
  "build",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/network/Cargo.toml",
  "--bin",
  "moss-network"
]);
cargo(
  [
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "phase6_registry_api",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    JS43_APP_URL: urls.app,
    JS43_WORKER_URL: urls.worker,
    JS43_BOOTSTRAP_URL: urls.bootstrap,
    JS43_MIGRATION_URL: urls.migration,
    JS170_AUTH_URL: urls.auth,
    JS170_SERVER:
      process.env.JS414_SERVER ?? join(process.env.CARGO_TARGET_DIR!, "debug/moss-shell"),
    JS170_CERTIFICATE: join(process.env.CARGO_TARGET_DIR!, "debug/moss-network")
  }
);

cargo([
  "test",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/module-publisher/Cargo.toml",
  "--test",
  "phase6_registry_artifacts",
  "--",
  "--test-threads=1"
]);
