/**
 * Promoting a staged candidate (#2689 slice 4): the flip, the kept previous release, and the sweep.
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

describe("promoteCandidate", () => {
  it("flips every package, keeps the previous release, and clears the candidate", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    const liveCli = await currentOf("anthropic");
    await svc.stageCandidate("anthropic", toolset, 7);

    expect(await svc.promoteCandidate("anthropic")).toEqual({ state: "promoted" });

    expect(await currentOf("anthropic")).not.toBe(liveCli);
    const state = await readToolsState(toolsPrefix, "anthropic");
    expect(state.candidate).toEqual([]);
    expect(state.prior.map((p) => p.slot).sort()).toEqual(["anthropic", "anthropic-adapter"]);
    expect(await releases("anthropic")).toHaveLength(2);
  });

  it("keeps the previous release through the boot sweep", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    await svc.stageCandidate("anthropic", toolset, 7);
    await svc.promoteCandidate("anthropic");
    await svc.startupSweep();
    expect(await releases("anthropic")).toHaveLength(2);
  });

  it("frees the older previous release on the next promote", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    await svc.stageCandidate("anthropic", toolset, 7);
    await svc.promoteCandidate("anthropic");
    await svc.stageCandidate("anthropic", [{ ...toolset[0], version: "9.9.10" }, toolset[1]], 8);
    await svc.promoteCandidate("anthropic");
    expect(await releases("anthropic")).toHaveLength(2);
  });

  it("refuses when nothing is staged and leaves current alone", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    const live = await currentOf("anthropic");
    expect((await svc.promoteCandidate("anthropic")).state).toBe("error");
    expect(await currentOf("anthropic")).toBe(live);
  });

  it("records a check result and clears it when a new candidate is staged", async () => {
    const svc = service();
    await svc.installProvider("anthropic");
    await svc.stageCandidate("anthropic", toolset, 7);
    await svc.recordCheck("anthropic", {
      at: "2026-09-30T00:00:00Z",
      result: "failed",
      reason: "tool_call_missing",
      versions: [NEW_CLI]
    });
    expect((await svc.toolsState()).lastCheck.anthropic?.reason).toBe("tool_call_missing");
    await svc.stageCandidate("anthropic", [{ ...toolset[0], version: "9.9.10" }], 8);
    expect((await svc.toolsState()).lastCheck.anthropic).toBeNull();
  });

  it("keeps a promoted release newer than the image pin when the runner restarts", async () => {
    const first = service();
    await first.installProvider("anthropic");
    await first.stageCandidate("anthropic", toolset, 7);
    await first.promoteCandidate("anthropic");
    const live = await currentOf("anthropic");

    // A fresh service is a restarted runner: boot reconcile asks for the image pin again.
    const result = await service().installProvider("anthropic");

    expect(result).toMatchObject({ state: "installed", version: NEW_CLI, alreadyInstalled: true });
    expect(await currentOf("anthropic")).toBe(live);
  });
});
