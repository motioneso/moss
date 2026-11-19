import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function prepareNotesToolComponent(): void {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  if (process.env.NOTES_TOOL_COMPONENT) return;
  const target = (process.env.CARGO_TARGET_DIR ??= "/tmp/moss-notes-host");
  const component = join(target, "notes-tools.wasm");
  const result = spawnSync("modules/notes/tools/build-component.sh", [component], {
    stdio: "inherit",
    env: { ...process.env, NOTES_TOOL_CHECKPOINT: "1" }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  process.env.NOTES_TOOL_COMPONENT = component;
}
