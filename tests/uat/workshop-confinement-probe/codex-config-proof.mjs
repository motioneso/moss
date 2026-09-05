// No model/auth call: exercise only installed Codex configuration discovery in synthetic homes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = await realpath("/data/cli-tools/bin/codex");
const root = await mkdtemp(join(tmpdir(), "workshop-codex-config-"));
const ambient = join(root, "ambient");
const isolated = join(root, "isolated");
const project = join(root, "project");
const neutral = join(root, "neutral");

async function run(home, cwd, args) {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd,
    detached: true,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      CODEX_HOME: home,
      LANG: "C.UTF-8"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let stdout = "";
  let bytes = 0;
  let overflow = false;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    stop();
  }, 15_000);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 65_536) {
        overflow = true;
        stop();
      } else if (stream === child.stdout) stdout += chunk.toString("utf8");
    });
  }
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(expired, false, "CLI configuration command timed out");
    assert.equal(overflow, false, "CLI configuration output exceeded limit");
    assert.equal(code, 0, "CLI configuration command failed; raw output discarded");
    return stdout;
  } finally {
    clearTimeout(timer);
    stop();
  }
}

try {
  for (const path of [ambient, isolated, neutral, join(project, ".codex"), join(project, ".git")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const trust = `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`;
  const server = (name) => `[mcp_servers.${name}]\ncommand = "/usr/bin/false"\n`;
  await writeFile(join(ambient, "config.toml"), trust + server("user_fixture"), { mode: 0o600 });
  await writeFile(join(isolated, "config.toml"), trust, { mode: 0o600 });
  await writeFile(join(project, ".codex/config.toml"), server("project_fixture"), { mode: 0o600 });
  const version = (await run(isolated, neutral, ["--version"])).trim();
  assert.match(version, /^codex-cli [0-9.]+$/);
  const flags = [
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.apply_patch_tool=false",
    "--disable",
    "apps",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"'
  ];
  const list = async (home, cwd, extra = []) => {
    const value = JSON.parse(await run(home, cwd, [...flags, ...extra, "mcp", "list", "--json"]));
    assert.ok(Array.isArray(value));
    return value
      .filter((entry) => entry.enabled)
      .map((entry) => entry.name)
      .sort();
  };
  const ambientNames = await list(ambient, project);
  assert.deepEqual(ambientNames, ["project_fixture", "user_fixture"]);
  const emptyOverride = await list(ambient, project, ["-c", "mcp_servers={}"]);
  // Negative control: an empty map does not clear inherited tables in this installed version.
  assert.deepEqual(emptyOverride, ambientNames);
  const projectNames = await list(isolated, project);
  assert.deepEqual(projectNames, ["project_fixture"]);
  assert.deepEqual(await list(isolated, neutral), []);
  console.log(
    JSON.stringify({
      check: "codex-synthetic-config-discovery",
      status: "pass",
      version,
      ambient: ambientNames,
      empty_map_override: emptyOverride,
      isolated_home_trusted_project: projectNames,
      isolated_home_neutral_directory: [],
      model_calls: 0,
      credential_files_supplied: false,
      unproved: [
        "native-tool execution",
        "hook execution",
        "system/managed configuration",
        "authenticated source generation",
        "production runner composition"
      ]
    })
  );
} finally {
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ check: "synthetic-config-cleanup", status: "pass" }));
}
