import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "CARGO_TARGET_DIR"]) {
  if (!process.env[name]) throw new Error(`Set ${name} before the gate`);
}
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.env.JS389_REMOVALS === "1") {
  run("python3", ["rust-spike/shell/tools/chat-part4d-removals.py"]);
  process.exit(0);
}
if (process.env.JS368_REMOVALS === "1") {
  const urls = getMossDatabaseUrls();
  Object.assign(process.env, {
    JS43_APP_URL: urls.app,
    JS43_WORKER_URL: urls.worker,
    JS43_BOOTSTRAP_URL: urls.bootstrap
  });
  run("python3", ["rust-spike/shell/tools/chat-bridge-removals.py"]);
  run("python3", ["rust-spike/agents/tools/list-removals.py"]);
  run("python3", ["rust-spike/module-host/tools/chat-host-removals.py"]);
  process.exit(0);
}
if (process.env.JS383_REMOVALS === "1") {
  run("python3", ["rust-spike/shell/tools/chat-cards-removals.py"]);
  process.exit(0);
}
if (process.env.JS370_REMOVALS === "1") {
  run("python3", ["rust-spike/shell/tools/chat-approvals-removals.py"]);
  process.exit(0);
}
run("pnpm", ["test:rust-chat-host"]);
run("cargo", [
  "+1.95.0",
  "test",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/agents/Cargo.toml"
]);
run("cargo", [
  "+1.95.0",
  "test",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/shell/Cargo.toml",
  "--",
  "--test-threads=1"
]);
run("pnpm", ["test:rust-scratchpad"]);
