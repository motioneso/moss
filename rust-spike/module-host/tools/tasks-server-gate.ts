import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR"]) {
  if (!process.env[name]) throw new Error(`Use task-owned ${name}`);
}
const urls = getMossDatabaseUrls();
const scratch = mkdtempSync(join(tmpdir(), "moss-tasks-server-"));
function run(command: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extra }
  });
  if (result.status !== 0) {
    rmSync(scratch, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }
}
const cargo = (args: string[], extra: Record<string, string> = {}) =>
  run("cargo", ["+1.95.0", ...args], extra);
const component = join(scratch, "module.wasm");
const pkg = join(scratch, "tasks.mosspkg");
run("bash", ["modules/tasks/tools/build-component.sh", component]);
cargo([
  "run",
  "--offline",
  "--locked",
  "--manifest-path",
  "modules/tasks/tools/Cargo.toml",
  "--bin",
  "tasks-pack",
  "--",
  component,
  pkg
]);
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
    "tasks_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
    JS182_TASKS_PACKAGE: pkg,
    JS43_APP_URL: urls.app,
    JS43_WORKER_URL: urls.worker,
    JS43_BOOTSTRAP_URL: urls.bootstrap,
    JS170_AUTH_URL: urls.auth,
    JS170_SERVER: join(process.env.CARGO_TARGET_DIR!, "debug/moss-shell"),
    JS170_CERTIFICATE: join(process.env.CARGO_TARGET_DIR!, "debug/moss-network")
  }
);
rmSync(scratch, { recursive: true, force: true });
