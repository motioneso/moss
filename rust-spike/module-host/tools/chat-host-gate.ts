import { spawnSync } from "node:child_process";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "CARGO_TARGET_DIR"]) {
  if (!process.env[name]) throw new Error(`Set ${name} before the gate`);
}
const urls = getMossDatabaseUrls();
const env = {
  ...process.env,
  JS43_APP_URL: urls.app,
  JS43_WORKER_URL: urls.worker,
  JS43_BOOTSTRAP_URL: urls.bootstrap
};
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const cargo = [
  "+1.95.0",
  "test",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/module-host/Cargo.toml"
];
if (process.env.JS361_REMOVAL_PROOF === "1") {
  run("python3", ["rust-spike/module-host/tools/chat-host-removals.py"]);
} else {
  run("cargo", cargo);
  run("cargo", [
    ...cargo,
    "--test",
    "chat_tools",
    "chat_tool_reads_use_the_actor_under_real_rls_including_admin",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ]);
}
