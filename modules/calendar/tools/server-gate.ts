/** Real Rust server over HTTPS with the installed Calendar package. Run through verify-gate. */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR"]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
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
    "calendar_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
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
    JS170_SERVER: join(process.env.CARGO_TARGET_DIR!, "debug/moss-shell"),
    JS170_CERTIFICATE: join(process.env.CARGO_TARGET_DIR!, "debug/moss-network")
  }
);
