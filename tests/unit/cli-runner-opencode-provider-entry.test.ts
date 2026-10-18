import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-entry-"));
  dirs.push(dir);
  const configDir = join(dir, "home", ".config", "opencode");
  return { dir, configDir, path: join(configDir, "opencode.json") };
}

function run(request: unknown) {
  return spawnSync(process.execPath, [SCRIPT, JSON.stringify(request)], {
    input: "",
    encoding: "utf8"
  });
}

const entry = {
  baseUrl: "http://proxy.test/v1",
  model: "org/model:tag@v2",
  apiKeyEnv: "MOSS_OPENCODE_API_KEY"
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent-home-prepare OpenCode provider entry", () => {
  it("writes the entry with an env reference and keeps the deny settings", () => {
    const { configDir, path } = setup();
    const result = run({
      dirs: [configDir],
      denyFile: { path, permissionKeys: ["bash"] },
      opencodeProvider: { path, id: "moss", entry }
    });
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.permission).toEqual({ bash: "deny" });
    expect(config.provider).toEqual({
      moss: {
        npm: "@ai-sdk/openai-compatible",
        name: "Moss",
        options: { baseURL: "http://proxy.test/v1", apiKey: "{env:MOSS_OPENCODE_API_KEY}" },
        models: { "org/model:tag@v2": {} }
      }
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removes only its own entry and keeps everything else", () => {
    const { configDir, path } = setup();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ permission: { bash: "deny" }, provider: { moss: {}, other: { name: "x" } } })
    );
    expect(
      run({
        dirs: [configDir],
        denyFile: null,
        opencodeProvider: { path, id: "moss", entry: null }
      }).status
    ).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      permission: { bash: "deny" },
      provider: { other: { name: "x" } }
    });
  });

  it("drops an empty provider object after removal", () => {
    const { configDir, path } = setup();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: { moss: {} } }));
    run({ dirs: [configDir], denyFile: null, opencodeProvider: { path, id: "moss", entry: null } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("creates no file when there is nothing to remove", () => {
    const { configDir, path } = setup();
    const result = run({
      dirs: [configDir],
      denyFile: null,
      opencodeProvider: { path, id: "moss", entry: null }
    });
    expect(result.status).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an entry carrying any field beyond address, model and variable name", () => {
    const { configDir, path } = setup();
    const result = run({
      dirs: [configDir],
      denyFile: null,
      opencodeProvider: {
        path,
        id: "moss",
        entry: { ...entry, apiKey: "test-key-never-land-0002" }
      }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("test-key-never-land-0002");
    expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain(
      "test-key-never-land-0002"
    );
  });

  it.each([
    ["a file address", { ...entry, baseUrl: "file:///etc/passwd" }],
    ["a lowercase variable name", { ...entry, apiKeyEnv: "moss_key" }],
    ["a model with a space", { ...entry, model: "a b" }]
  ])("refuses %s", (_label, bad) => {
    const { configDir, path } = setup();
    expect(
      run({ dirs: [configDir], denyFile: null, opencodeProvider: { path, id: "moss", entry: bad } })
        .status
    ).toBe(1);
  });

  it.each([
    ["a username and password", "http://user:hunter2pw@proxy.test/v1"],
    ["a password alone", "http://:hunter2pw@proxy.test/v1"]
  ])("refuses an address carrying %s, naming no part of it", (_label, baseUrl) => {
    const { configDir, path } = setup();
    const result = run({
      dirs: [configDir],
      denyFile: null,
      opencodeProvider: {
        path,
        id: "moss",
        entry: { ...entry, baseUrl }
      }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "opencodeProvider.entry.baseUrl must not include a username or password"
    );
    expect(result.stderr).not.toContain("hunter2pw");
    expect(existsSync(path)).toBe(false);
  });

  it("replaces a planted symlink instead of writing through it", () => {
    const { dir, configDir, path } = setup();
    mkdirSync(configDir, { recursive: true });
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, path);
    expect(
      run({ dirs: [configDir], denyFile: null, opencodeProvider: { path, id: "moss", entry } })
        .status
    ).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("{}");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
  });
});
