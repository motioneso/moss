// Runs only while building the image from the pinned public Playwright image.
import assert from "node:assert/strict";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

function copy(from, to = from) {
  const destination = `/runtime${to}`;
  mkdirSync(dirname(destination), { recursive: true });
  if (statSync(from).isDirectory())
    cpSync(from, destination, { recursive: true, dereference: true });
  else copyFileSync(realpathSync(from), destination);
}

const shells = readdirSync("/ms-playwright").filter((name) =>
  name.startsWith("chromium_headless_shell-")
);
assert.equal(shells.length, 1, "pinned image must contain exactly one headless Chromium");
const root = join("/ms-playwright", shells[0]);
const directory = [root, ...readdirSync(root).map((name) => join(root, name))].find(
  (path) =>
    existsSync(join(path, "chrome-headless-shell")) || existsSync(join(path, "headless_shell"))
);
assert.ok(directory, "headless Chromium binary missing");
const executable = existsSync(join(directory, "chrome-headless-shell"))
  ? "chrome-headless-shell"
  : "headless_shell";

for (const binary of ["/usr/bin/node", join(directory, executable)]) {
  const output = execFileSync("ldd", [binary], { encoding: "utf8" });
  assert.ok(!output.includes("not found"), "public toolchain library missing");
  const libraries = [...output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(
    (match) => match[1]
  );
  assert.ok(libraries.length > 0, "runtime library inventory is empty");
  for (const library of new Set(libraries)) copy(library);
}
copy("/usr/bin/node", "/usr/local/bin/node");
copy(directory, "/opt/chromium");
// Keep the browser's companion files together; the runtime uses this fixed executable name.
copy(join(directory, executable), "/opt/chromium/headless_shell");
copy("/build/node_modules", "/opt/node_modules");
copy("/etc/fonts");
copy("/usr/share/fonts");
mkdirSync("/runtime/attempt", { recursive: true });
