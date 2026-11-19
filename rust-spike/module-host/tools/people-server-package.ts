import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Build the current checkout's real People package for the installed-server gates. */
export function buildPeopleServerPackage(target: string) {
  const directory = join(target, "server-packages", "people");
  mkdirSync(directory, { recursive: true });
  const component = join(directory, "module.wasm");
  const ui = join(directory, "ui");
  const pkg = join(directory, "people.mossmod");
  function run(command: string, args: string[]) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  run("bash", ["modules/people/tools/build-component.sh", component]);
  run("bash", ["modules/people/ui/build.sh", ui]);
  run("cargo", [
    "+1.95.0",
    "run",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--example",
    "pack_people",
    "--",
    component,
    ui,
    pkg
  ]);
  return { JS50_PEOPLE_COMPONENT: component, JS73_PEOPLE_PACKAGE: pkg };
}
