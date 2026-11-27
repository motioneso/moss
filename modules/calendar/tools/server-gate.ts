/** Real Rust server over HTTPS with the installed Calendar package. Run through verify-gate. */
import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR"]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
const address = Object.values(networkInterfaces())
  .flat()
  .find((n) => n?.family === "IPv4" && !n.internal)?.address;
if (!address) throw new Error("The live check needs a LAN or tailnet address");
const urls = getMossDatabaseUrls();
const target = process.env.CARGO_TARGET_DIR!;
const packages = join(target, "server-packages", "calendar");
mkdirSync(packages, { recursive: true });
const calendarPackage = join(packages, "calendar.mosspkg");
const tasksComponent = join(packages, "tasks.wasm");
const tasksPackage = join(packages, "tasks.mosspkg");
const calendarUi = join(packages, "ui");
function run(command: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extra }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function cargo(args: string[], extra: Record<string, string> = {}) {
  run("cargo", ["+1.95.0", ...args], extra);
}
// Keep the standalone Tasks test graph separate from the host workspace's SDK artifacts.
cargo(
  [
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "modules/tasks/src/Cargo.toml",
    "--test",
    "reference"
  ],
  { CARGO_TARGET_DIR: join(target, "tasks-reference") }
);
run("bash", ["modules/calendar/tools/build-ui.sh"], {
  CALENDAR_UI_DIR: calendarUi,
  CALENDAR_UI_TARGET: join(target, "calendar-ui"),
  CALENDAR_BINDGEN_TARGET: target
});
const calendarGuest = join(target, "calendar-guest");
cargo(
  [
    "build",
    "--offline",
    "--locked",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    "modules/calendar/src/Cargo.toml"
  ],
  {
    CARGO_TARGET_DIR: calendarGuest,
    RUSTFLAGS:
      "-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864"
  }
);
cargo(
  [
    "run",
    "--offline",
    "--locked",
    "--manifest-path",
    "modules/calendar/host/Cargo.toml",
    "--bin",
    "calendar-package",
    "--",
    join(calendarGuest, "wasm32-unknown-unknown/release/moss_calendar.wasm"),
    calendarPackage
  ],
  { CALENDAR_UI_DIR: calendarUi }
);
run("bash", ["modules/tasks/tools/build-component.sh", tasksComponent], {
  TASKS_GUEST_TARGET_DIR: join(target, "tasks-guest")
});
cargo([
  "run",
  "--offline",
  "--locked",
  "--manifest-path",
  "modules/tasks/tools/Cargo.toml",
  "--bin",
  "tasks-pack",
  "--",
  tasksComponent,
  tasksPackage
]);
// Build the actual Today shell used by the installed-screen browser proof.
const shellWeb = join(target, "calendar-shell-web");
cargo(
  [
    "build",
    "--offline",
    "--locked",
    "--release",
    "--manifest-path",
    "rust-spike/shell/Cargo.toml",
    "-p",
    "moss-shell-ui",
    "--target",
    "wasm32-unknown-unknown"
  ],
  { CARGO_TARGET_DIR: join(target, "calendar-ui") }
);
run(join(target, "release/ui-bindgen"), [
  join(target, "calendar-ui/wasm32-unknown-unknown/release/moss-shell-ui.wasm"),
  shellWeb,
  "app"
]);
run("python3", ["rust-spike/shell/assets/build-assets.py", shellWeb]);
run("cp", ["rust-spike/shell/assets/index.html", join(shellWeb, "index.html")]);
// The browser check and the shared screen styles are part of the gate.
const sharedDir = join(target, "calendar-shared");
if (
  spawnSync("python3", ["rust-spike/module-ui/build-assets.py", sharedDir], { stdio: "inherit" })
    .status !== 0
) {
  throw new Error("shared screen assets did not build");
}
cargo([
  "build",
  "--offline",
  "--locked",
  "--manifest-path",
  "rust-spike/shell/Cargo.toml",
  "-p",
  "moss-server"
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
// Only disposable CI answers the graphical firewall approval with a scripted
// approval. The production helper still adds, checks and removes the real rule.
// Local runs keep the normal owner prompt.
const firewallApproval: Record<string, string> = {};
if (process.env.GITHUB_ACTIONS === "true") {
  if (spawnSync("sudo", ["-n", "ufw", "show", "added"], { stdio: "inherit" }).status !== 0) {
    throw new Error("The CI firewall approval needs passwordless sudo and ufw");
  }
  const standIn = join(target, "calendar-firewall-approve");
  writeFileSync(standIn, '#!/bin/sh\nexec sudo -n -- "$@"\n', { mode: 0o700 });
  firewallApproval.MOSS_FIREWALL_STAND_IN = standIn;
}
cargo(
  [
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "calendar_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
    ...firewallApproval,
    MOSS_CALENDAR_PUBLIC_HOST: address,
    MOSS_CALENDAR_SHELL_WEB: shellWeb,
    JS181_CALENDAR_PACKAGE: calendarPackage,
    JS220_TASKS_PACKAGE: tasksPackage,
    MOSS_MODULE_SHARED_DIR: sharedDir,
    MOSS_CALENDAR_BROWSER_SCRIPT: join(process.cwd(), "modules/calendar/tools/server-browser.ts"),
    MOSS_CALENDAR_BROWSER_OUT:
      process.env.MOSS_CALENDAR_BROWSER_OUT ??
      join(process.env.CARGO_TARGET_DIR!, "calendar-shots"),
    JS43_APP_URL: urls.app,
    JS43_WORKER_URL: urls.worker,
    JS43_BOOTSTRAP_URL: urls.bootstrap,
    JS170_AUTH_URL: urls.auth,
    JS170_SERVER: join(process.env.CARGO_TARGET_DIR!, "debug/moss-server"),
    JS170_CERTIFICATE: join(process.env.CARGO_TARGET_DIR!, "debug/moss-network")
  }
);
