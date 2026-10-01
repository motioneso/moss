/**
 * Staging a candidate toolset (#2689 slice 4): the new tools are installed beside the live ones,
 * the live link never moves, the lockfile comes from the manifest, and the boot sweep keeps them.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/index.js";
import { ADAPTER_CATALOG, PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import { InstallService } from "../../packages/cli-runner/src/install-service.js";
import { readToolsState } from "../../packages/cli-runner/src/tools-state.js";

const CLI_PKG = "@anthropic-ai/claude-code";
const ADAPTER_PKG = "@agentclientprotocol/claude-agent-acp";
const cli = PROVIDER_CATALOG.anthropic.recipe;
if (cli?.kind !== "npm") throw new Error("fixture: anthropic recipe missing");
const CLI_VERSION = cli.version;
const adapter = ADAPTER_CATALOG.anthropic;
if (!adapter) throw new Error("fixture: anthropic adapter missing");

const NEW_CLI = "9.9.9";
const NEW_ADAPTER = "8.8.8";

let seenLock: string[];
let adapterCiFails: boolean;

function makeIo(): TmuxIo {
  return {
    run: async (cmd, args) => {
      if (cmd === "npm" && args[0] === "ci") {
        const staging = args[args.indexOf("--prefix") + 1] as string;
        seenLock.push(await readFile(path.join(staging, "npm-shrinkwrap.json"), "utf8"));
        const manifest = JSON.parse(await readFile(path.join(staging, "package.json"), "utf8"));
        const nm = path.join(staging, "node_modules");
        if (manifest.dependencies[ADAPTER_PKG]) {
          if (adapterCiFails) return { code: 1, stdout: "", stderr: "npm ci boom" };
          await mkdir(path.join(nm, ADAPTER_PKG, "dist"), { recursive: true });
          await writeFile(
            path.join(nm, ADAPTER_PKG, "package.json"),
            JSON.stringify({ name: ADAPTER_PKG, version: manifest.dependencies[ADAPTER_PKG] })
          );
          await writeFile(path.join(nm, ADAPTER_PKG, "dist", "index.js"), "//");
          return { code: 0, stdout: "", stderr: "" };
        }
        const version = manifest.dependencies[CLI_PKG] as string;
        await mkdir(path.join(nm, CLI_PKG, "bin"), { recursive: true });
        await mkdir(path.join(nm, ".bin"), { recursive: true });
        await writeFile(path.join(nm, CLI_PKG, "package.json"), JSON.stringify({ version }));
        await writeFile(
          path.join(nm, CLI_PKG, "bin", "claude.exe"),
          `#!/usr/bin/env node\n${version}\n`,
          {
            mode: 0o755
          }
        );
        await mkdir(path.join(nm, "@anthropic-ai/claude-code-linux-x64"), { recursive: true });
        await writeFile(
          path.join(nm, "@anthropic-ai/claude-code-linux-x64", "claude"),
          `#!/usr/bin/env node\n${version}\n`,
          {
            mode: 0o755
          }
        );
        await symlink(
          path.join("..", CLI_PKG, "bin", "claude.exe"),
          path.join(nm, ".bin", "claude")
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.length === 1 && args[0] === "--version") {
        const bin = await readFile(cmd, "utf8").catch(() => "");
        const v = /\n(\d+\.\d+\.\d+)\n/.exec(bin)?.[1] ?? CLI_VERSION;
        return { code: 0, stdout: `${v}\n`, stderr: "" };
      }
      if (cmd === "ls") {
        try {
          return {
            code: 0,
            stdout: (await readdir(args[args.length - 1] as string)).join("\n"),
            stderr: ""
          };
        } catch {
          return { code: 1, stdout: "", stderr: "" };
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: async (p) => readFile(p, "utf8"),
    writeFile: async (p, c) => writeFile(p, c, "utf8"),
    sleep: async () => undefined
  };
}

let toolsPrefix: string;
let homeBase: string;
beforeEach(async () => {
  seenLock = [];
  adapterCiFails = false;
  toolsPrefix = await mkdtemp(path.join(tmpdir(), "jarv1s-cand-tools-"));
  homeBase = await mkdtemp(path.join(tmpdir(), "jarv1s-cand-home-"));
});
afterEach(async () => {
  await rm(toolsPrefix, { recursive: true, force: true });
  await rm(homeBase, { recursive: true, force: true });
});

const service = () =>
  new InstallService({
    io: makeIo(),
    catalog: PROVIDER_CATALOG,
    adapterCatalog: ADAPTER_CATALOG,
    toolsPrefix,
    homeBase,
    hostArch: "x64"
  });

const providers = () => path.join(toolsPrefix, "providers");
const releases = (slot: string) => readdir(path.join(providers(), slot, "releases"));
const currentOf = (slot: string) => readlink(path.join(providers(), slot, "current"));

const toolset = [
  { role: "cli", pkg: CLI_PKG, version: NEW_CLI, lockfileText: '{"from":"manifest-cli"}' },
  {
    role: "chat-adapter",
    pkg: ADAPTER_PKG,
    version: NEW_ADAPTER,
    lockfileText: '{"from":"manifest-adapter"}'
  }
] as const;

describe("stageCandidate", () => {
  it("installs beside the live toolset, never moves current, and uses the manifest lockfiles", async () => {
    const svc = service();
    expect((await svc.installProvider("anthropic")).state).toBe("installed");
    const liveCli = await currentOf("anthropic");
    const liveAdapter = await currentOf("anthropic-adapter");

    const r = await svc.stageCandidate("anthropic", toolset, 7);
    expect(r).toMatchObject({ state: "staged" });

    expect(await currentOf("anthropic")).toBe(liveCli);
    expect(await currentOf("anthropic-adapter")).toBe(liveAdapter);
    expect(await releases("anthropic")).toHaveLength(2);
    expect(await releases("anthropic-adapter")).toHaveLength(2);
    expect(seenLock).toContain('{"from":"manifest-cli"}');
    expect(seenLock).toContain('{"from":"manifest-adapter"}');

    const state = await readToolsState(toolsPrefix, "anthropic");
    expect(state.manifestSequence).toBe(7);
    expect(state.candidate.map((c) => [c.slot, c.version])).toEqual([
      ["anthropic", NEW_CLI],
      ["anthropic-adapter", NEW_ADAPTER]
    ]);
  });

  it("keeps a staged candidate through the boot sweep but removes an unlisted release", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    await svc.stageCandidate("anthropic", toolset, 7);
    const orphan = path.join(providers(), "anthropic", "releases", "orphan123");
    await mkdir(orphan, { recursive: true });

    await svc.startupSweep();

    const left = await releases("anthropic");
    expect(left).toHaveLength(2);
    expect(left).not.toContain("orphan123");
  });

  it("refuses a package this image does not list, and stages nothing", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    const r = await svc.stageCandidate(
      "anthropic",
      [{ role: "cli", pkg: "evil-package", version: "1.0.0", lockfileText: "{}" }],
      3
    );
    expect(r.state).toBe("error");
    expect(await releases("anthropic")).toHaveLength(1);
    expect((await readToolsState(toolsPrefix, "anthropic")).candidate).toEqual([]);
  });

  it("removes what it staged when a later package fails", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    adapterCiFails = true;
    const r = await svc.stageCandidate("anthropic", toolset, 3);
    expect(r.state).toBe("error");
    expect(await releases("anthropic")).toHaveLength(1);
    expect((await readToolsState(toolsPrefix, "anthropic")).candidate).toEqual([]);
  });
});
