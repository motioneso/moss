/** Holds a real installed server and disposable DB for chat bridge and approval UI proof. */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const key of ["CARGO_HOME", "CARGO_TARGET_DIR", "RUSTUP_HOME", "MOSS_CHAT_BRIDGE_PROOF"]) {
  if (!process.env[key]) throw new Error(`Set ${key}`);
}
const target = process.env.CARGO_TARGET_DIR!;
const proof = process.env.MOSS_CHAT_BRIDGE_PROOF!;
mkdirSync(proof, { recursive: true });
const urls = getMossDatabaseUrls();
function run(command: string, args: string[], extra = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...extra } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const cargo = (manifest: string, args: string[]) =>
  run("cargo", ["+1.95.0", ...args, "--offline", "--locked", "--manifest-path", manifest]);
run("bash", ["modules/scratchpad/tools/build-component.sh", join(target, "module.wasm")]);
cargo("modules/scratchpad/host/Cargo.toml", ["build", "--bin", "scratchpad-package"]);
run(join(target, "debug/scratchpad-package"), [
  join(target, "module.wasm"),
  join(target, "scratchpad.mosspkg")
]);
if (process.env.MOSS_CHAT_COMMITMENTS_PROOF === "1") {
  run("bash", ["modules/commitments/tools/build-component.sh", join(target, "commitments.wasm")]);
  cargo("modules/commitments/host/Cargo.toml", ["build", "--bin", "commitments-package"]);
  run(join(target, "debug/commitments-package"), [
    join(target, "commitments.wasm"),
    join(target, "commitments.mosspkg")
  ]);
  process.env.JS383_COMMITMENTS_PACKAGE = join(target, "commitments.mosspkg");
}
if (process.env.MOSS_CHAT_PART4D_PROOF === "1") {
  run("bash", ["rust-spike/shell/tools/chat-part4d-live.sh"]);
  for (const module of ["tasks", "calendar", "email", "connectors", "meals", "web-research"]) {
    process.env[`JS389_${module.replaceAll("-", "_").toUpperCase()}_PACKAGE`] = join(
      target,
      `${module}.mosspkg`
    );
  }
}
if (process.env.MOSS_CHAT_NOTES_PROOF === "1") {
  run("bash", ["modules/notes/tools/build-component.sh", join(target, "notes.wasm")], {
    NOTES_TOOL_CHECKPOINT: "1",
    CARGO_TARGET_DIR: join(target, "notes-guest"),
    MOSS_HOST_TARGET_DIR: target
  });
  cargo("modules/notes/tools/Cargo.toml", ["build", "--bin", "notes-pack"]);
  run(join(target, "debug/notes-pack"), [
    join(target, "notes.wasm"),
    join(target, "notes.mosspkg")
  ]);
  process.env.JS388_NOTES_PACKAGE = join(target, "notes.mosspkg");
}
if (process.env.MOSS_CHAT_NEWS_PROOF === "1") {
  run("bash", ["modules/news/tools/build-component.sh", join(target, "news.wasm")]);
  cargo("modules/news/host/Cargo.toml", ["build", "--bin", "news-package"]);
  run(join(target, "debug/news-package"), [
    join(target, "news.wasm"),
    join(target, "news.mosspkg")
  ]);
  process.env.JS386_NEWS_PACKAGE = join(target, "news.mosspkg");
}
if (process.env.MOSS_CHAT_PART4B_PROOF === "1") {
  for (const module of ["sports", "wellness", "weather", "briefings"]) {
    run("bash", [`modules/${module}/tools/build-component.sh`, join(target, `${module}.wasm`)]);
    cargo(`modules/${module}/host/Cargo.toml`, ["build", "--bin", `${module}-package`]);
    run(join(target, `debug/${module}-package`), [
      join(target, `${module}.wasm`),
      join(target, `${module}.mosspkg`)
    ]);
    process.env[`JS387_${module.toUpperCase()}_PACKAGE`] = join(target, `${module}.mosspkg`);
  }
}
if (process.env.MOSS_CHAT_FINANCE_PROOF === "1") {
  run("bash", ["modules/finance/tools/build-component.sh", join(target, "finance.wasm")]);
  cargo("modules/finance/host/Cargo.toml", ["build", "--bin", "finance-package"]);
  run(join(target, "debug/finance-package"), [
    join(target, "finance.wasm"),
    join(target, "finance.mosspkg")
  ]);
  process.env.JS390_FINANCE_PACKAGE = join(target, "finance.mosspkg");
}
cargo("rust-spike/shell/Cargo.toml", ["build", "-p", "moss-shell", "--features", "live-proof"]);
cargo("rust-spike/agents/Cargo.toml", ["build", "--bins"]);
cargo("rust-spike/network/Cargo.toml", ["build", "--bin", "moss-network"]);
const web = join(proof, "web");
run("bash", ["modules/scratchpad/tools/screen-build.sh"], { MOSS_SCRATCHPAD_SCREEN_WEB: web });
const fixture = spawn(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "scratchpad_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      JS43_APP_URL: urls.app,
      JS43_WORKER_URL: urls.worker,
      JS43_BOOTSTRAP_URL: urls.bootstrap,
      JS170_AUTH_URL: urls.auth,
      JS170_SERVER: join(target, "debug/moss-shell"),
      JS170_CERTIFICATE: join(target, "debug/moss-network"),
      JS286_SCRATCHPAD_PACKAGE: join(target, "scratchpad.mosspkg"),
      MOSS_SCRATCHPAD_SCREEN_WEB: web,
      MOSS_MODULE_SHARED_DIR: join(web, "module-shared"),
      MOSS_SCRATCHPAD_HOLD: proof
    }
  }
);
fixture.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => fixture.kill("SIGTERM"));
// The fixture writes bridge.json only after installing the real package and asserting its routes.
const deadline = Date.now() + 300_000;
const timer = setInterval(() => {
  if (existsSync(join(proof, "bridge.json"))) {
    console.log("BRIDGE_LIVE_READY: installed server and two accounts; use the task browser");
    clearInterval(timer);
  } else if (Date.now() > deadline) {
    fixture.kill("SIGTERM");
    clearInterval(timer);
    throw new Error("Live fixture did not become ready");
  }
}, 500);
