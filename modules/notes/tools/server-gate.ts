import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["NOTES_TOOL_COMPONENT"]) {
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
const memoryGuestTarget = join(process.env.CARGO_TARGET_DIR!, "memory-guest");
cargo(
  [
    "build",
    "--offline",
    "--locked",
    "--release",
    "--lib",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    "modules/memory/src/Cargo.toml"
  ],
  {
    CARGO_TARGET_DIR: memoryGuestTarget,
    RUSTFLAGS:
      "-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864"
  }
);
process.env.MEMORY_CORE_WASM = join(
  memoryGuestTarget,
  "wasm32-unknown-unknown/release/moss_memory.wasm"
);
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
    "modules/notes/tools/Cargo.toml",
    "--test",
    "server",
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
