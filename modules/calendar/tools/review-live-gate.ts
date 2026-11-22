/** Today writes through real Calendar/Tasks/Connectors on the Rust server; only Google is a stand-in. */
import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const target = process.env.CARGO_TARGET_DIR;
if (!target || !process.env.CARGO_HOME) throw new Error("Set task-owned Cargo paths");
const host = Object.values(networkInterfaces())
  .flat()
  .find((n) => n?.family === "IPv4" && !n.internal)?.address;
if (!host) throw new Error("LAN or tailnet address required");
const web = join(target, "calendar-shell-web");
const ui = join(target, "calendar-ui");
function run(cmd: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...extra } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Build the actual shell, including its module section and parent modal bridge.
run(
  "cargo",
  [
    "+1.95.0",
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
  { CARGO_TARGET_DIR: ui }
);
run("cargo", [
  "+1.95.0",
  "build",
  "--offline",
  "--locked",
  "--release",
  "--manifest-path",
  "rust-spike/ui/bindgen/Cargo.toml"
]);
run(join(target, "release/ui-bindgen"), [
  join(ui, "wasm32-unknown-unknown/release/moss-shell-ui.wasm"),
  web,
  "app"
]);
run("python3", ["rust-spike/shell/assets/build-assets.py", web]);
run("cp", ["rust-spike/shell/assets/index.html", join(web, "index.html")]);
run("bash", ["modules/connectors/tools/live.sh"], {
  MOSS_CALENDAR_PUBLIC_HOST: host,
  MOSS_CALENDAR_SHELL_WEB: web,
  MOSS_CALENDAR_REVIEW_BROWSER_SCRIPT: join(
    process.cwd(),
    "modules/calendar/tools/review-write-browser.ts"
  )
});
