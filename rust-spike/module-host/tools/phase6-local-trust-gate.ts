import { spawnSync } from "node:child_process";
import { join } from "node:path";
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
  JS43_BOOTSTRAP_URL: urls.bootstrap,
  JS170_AUTH_URL: urls.auth,
  JS170_SERVER: join(process.env.CARGO_TARGET_DIR, "debug/moss-shell"),
  JS170_CERTIFICATE: join(process.env.CARGO_TARGET_DIR, "debug/moss-network"),
  JS408_MOSS: join(process.env.CARGO_TARGET_DIR, "debug/moss")
};
function cargo(args: string[]) {
  const result = spawnSync("cargo", ["+1.95.0", ...args], { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
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
cargo([
  "build",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/module-publisher/Cargo.toml",
  "--bin",
  "moss"
]);
cargo([
  "test",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/module-host/Cargo.toml",
  "--test",
  "phase6_local_trust",
  "--",
  "--include-ignored",
  "--nocapture",
  "--test-threads=1"
]);
