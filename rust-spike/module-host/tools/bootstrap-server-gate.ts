import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["JS50_PEOPLE_COMPONENT", "JS73_PEOPLE_PACKAGE"]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR"]) {
  if (!process.env[name]) throw new Error(`Use task-owned ${name}`);
}
const urls = getMossDatabaseUrls();
function cargo(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync("cargo", ["+1.95.0", ...args], {
    stdio: "inherit",
    env: { ...process.env, ...extra }
  });
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
cargo(
  [
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "bootstrap_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
    JS43_APP_URL: urls.app,
    JS43_WORKER_URL: urls.worker,
    JS43_BOOTSTRAP_URL: urls.bootstrap,
    JS170_AUTH_URL: urls.auth,
    JS170_SERVER: join(process.env.CARGO_TARGET_DIR!, "debug/moss-shell"),
    JS170_CERTIFICATE: join(process.env.CARGO_TARGET_DIR!, "debug/moss-network")
  }
);
