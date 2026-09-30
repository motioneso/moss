/**
 * Chat adapters on the tools volume (#2689 slice 2): installing a provider also installs its
 * chat adapter into its own slot, atomically promoted, verified, and never allowed to break
 * the CLI that installed beside it.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/index.js";
import {
  ADAPTER_CATALOG,
  PROVIDER_CATALOG,
  validateAdapterRecipe,
  type AdapterRecipe
} from "../../packages/cli-runner/src/catalog.js";
import { InstallService } from "../../packages/cli-runner/src/install-service.js";

const CLI_PKG = "@anthropic-ai/claude-code";
const ADAPTER_PKG = "@agentclientprotocol/claude-agent-acp";
const ADAPTER_ENTRY = `node_modules/${ADAPTER_PKG}/dist/index.js`;
const cliRecipe = PROVIDER_CATALOG.anthropic.recipe;
if (cliRecipe?.kind !== "npm") throw new Error("fixture: anthropic recipe missing");
const CLI_VERSION = cliRecipe.version;
const adapterRecipe = ADAPTER_CATALOG.anthropic as AdapterRecipe;

interface Behavior {
  adapterCiFails?: boolean;
  adapterVersion?: string;
  adapterNoEntry?: boolean;
}

function makeIo(behavior: Behavior = {}): { io: TmuxIo; adapterCis: () => number } {
  let adapterCis = 0;
  const io: TmuxIo = {
    run: async (cmd, args) => {
      if (cmd === "npm" && args[0] === "ci") {
        const staging = args[args.indexOf("--prefix") + 1] as string;
        const manifest = JSON.parse(await readFile(path.join(staging, "package.json"), "utf8"));
        const nm = path.join(staging, "node_modules");
        if (manifest.dependencies[ADAPTER_PKG]) {
          adapterCis += 1;
          if (behavior.adapterCiFails) return { code: 1, stdout: "", stderr: "npm ci boom" };
          await mkdir(path.join(nm, ADAPTER_PKG, "dist"), { recursive: true });
          await writeFile(
            path.join(nm, ADAPTER_PKG, "package.json"),
            JSON.stringify({
              name: ADAPTER_PKG,
              version: behavior.adapterVersion ?? adapterRecipe.version
            })
          );
          if (!behavior.adapterNoEntry) {
            await writeFile(path.join(nm, ADAPTER_PKG, "dist", "index.js"), "//", { mode: 0o644 });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        await mkdir(path.join(nm, CLI_PKG, "bin"), { recursive: true });
        await mkdir(path.join(nm, ".bin"), { recursive: true });
        await writeFile(
          path.join(nm, CLI_PKG, "package.json"),
          JSON.stringify({ version: CLI_VERSION })
        );
        await writeFile(path.join(nm, CLI_PKG, "bin", "claude.exe"), "#!/usr/bin/env node\n", {
          mode: 0o755
        });
        for (const archPkg of ["@anthropic-ai/claude-code-linux-x64"]) {
          await mkdir(path.join(nm, archPkg), { recursive: true });
          await writeFile(path.join(nm, archPkg, "claude"), "native\n", { mode: 0o755 });
        }
        await symlink(
          path.join("..", CLI_PKG, "bin", "claude.exe"),
          path.join(nm, ".bin", "claude")
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.length === 1 && args[0] === "--version") {
        return { code: 0, stdout: `${CLI_VERSION}\n`, stderr: "" };
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
  return { io, adapterCis: () => adapterCis };
}

let toolsPrefix: string;
let homeBase: string;
beforeEach(async () => {
  toolsPrefix = await mkdtemp(path.join(tmpdir(), "jarv1s-adapter-tools-"));
  homeBase = await mkdtemp(path.join(tmpdir(), "jarv1s-adapter-home-"));
});
afterEach(async () => {
  await rm(toolsPrefix, { recursive: true, force: true });
  await rm(homeBase, { recursive: true, force: true });
});

const service = (
  io: TmuxIo,
  adapters: Partial<Record<"anthropic", AdapterRecipe>> = ADAPTER_CATALOG
) =>
  new InstallService({
    io,
    catalog: PROVIDER_CATALOG,
    adapterCatalog: adapters,
    toolsPrefix,
    homeBase,
    hostArch: "x64"
  });

const adapterDir = () => path.join(toolsPrefix, "providers", "anthropic-adapter");
async function adapterRelease(): Promise<string> {
  const link = await (
    await import("node:fs/promises")
  ).readlink(path.join(adapterDir(), "current"));
  return path.resolve(adapterDir(), link);
}

describe("adapter catalog", () => {
  it("has a validated entry for claude and codex, and rejects a range or a missing lockfile", () => {
    expect(ADAPTER_CATALOG.anthropic?.pkg).toBe(ADAPTER_PKG);
    expect(ADAPTER_CATALOG["openai-compatible"]?.pkg).toBe("@agentclientprotocol/codex-acp");
    expect(validateAdapterRecipe(adapterRecipe)).toBeNull();
    expect(validateAdapterRecipe({ ...adapterRecipe, version: "^0.75.1" })).toMatch(/not exact/);
    expect(validateAdapterRecipe({ ...adapterRecipe, lockfile: "recipes/nope.json" })).toMatch(
      /lockfile/
    );
  });
});

describe("installing a provider also installs its chat adapter", () => {
  it("promotes the adapter into its own slot with a pinned, script-free install", async () => {
    const { io } = makeIo();
    const calls: string[][] = [];
    const spy: TmuxIo = { ...io, run: async (c, a, o) => (calls.push([c, ...a]), io.run(c, a, o)) };
    const result = await service(spy).installProvider("anthropic");
    expect(result.state).toBe("installed");

    const release = await adapterRelease();
    expect((await stat(path.join(release, ADAPTER_ENTRY))).isFile()).toBe(true);
    expect(
      (await stat(path.join(toolsPrefix, "providers", "anthropic", "current"))).isDirectory()
    ).toBe(true);
    const adapterCi = calls.find(
      (c) => c[0] === "npm" && c.some((x) => x.includes("anthropic-adapter"))
    );
    expect(adapterCi).toContain("--ignore-scripts");
    // No stray staging left behind, and no bin symlink for a package with no binary.
    expect(await readdir(path.join(toolsPrefix, ".staging"))).toHaveLength(0);
    await expect(lstat(path.join(toolsPrefix, "bin", "claude-agent-acp"))).rejects.toThrow();
  });

  it("publishes the adapter release folder as 0755 regardless of the runner umask", async () => {
    const previous = process.umask(0o077);
    try {
      await service(makeIo().io).installProvider("anthropic");
    } finally {
      process.umask(previous);
    }
    expect((await stat(await adapterRelease())).mode & 0o777).toBe(0o755);
  });

  it("re-installing with the adapter already live does not reinstall it", async () => {
    const { io, adapterCis } = makeIo();
    const svc = service(io);
    await svc.installProvider("anthropic");
    await svc.installProvider("anthropic");
    expect(adapterCis()).toBe(1);
  });

  it("an adapter failure reports an error but leaves the CLI installed and no adapter live", async () => {
    const result = await service(makeIo({ adapterCiFails: true }).io).installProvider("anthropic");
    expect(result.state).toBe("error");
    expect(result.message).toMatch(/adapter/i);
    expect((await stat(path.join(toolsPrefix, "bin", "claude"))).isFile()).toBe(true);
    await expect(lstat(path.join(adapterDir(), "current"))).rejects.toThrow();
  });

  it("refuses to promote an adapter whose version is not the pin or whose entry is missing", async () => {
    expect(
      (await service(makeIo({ adapterVersion: "0.0.1" }).io).installProvider("anthropic")).state
    ).toBe("error");
    await expect(lstat(path.join(adapterDir(), "current"))).rejects.toThrow();
    expect(
      (await service(makeIo({ adapterNoEntry: true }).io).installProvider("anthropic")).state
    ).toBe("error");
    await expect(lstat(path.join(adapterDir(), "current"))).rejects.toThrow();
  });

  it("a failed adapter upgrade keeps the previous adapter live", async () => {
    await service(makeIo().io).installProvider("anthropic");
    const before = await adapterRelease();
    const bumped = { anthropic: { ...adapterRecipe, version: "9.9.9" } };
    const result = await service(makeIo({ adapterCiFails: true }).io, bumped).installProvider(
      "anthropic"
    );
    expect(result.state).toBe("error");
    expect(await adapterRelease()).toBe(before);
  });

  it("boot reconcile restores a missing adapter for an installed provider", async () => {
    await service(makeIo().io).installProvider("anthropic");
    await rm(adapterDir(), { recursive: true, force: true });
    await service(makeIo().io).reconcileInstalledProviders();
    expect((await stat(path.join(await adapterRelease(), ADAPTER_ENTRY))).isFile()).toBe(true);
  });

  it("startup sweep removes adapter releases that are not live", async () => {
    await service(makeIo().io).installProvider("anthropic");
    const orphan = path.join(adapterDir(), "releases", "orphan");
    await mkdir(orphan, { recursive: true });
    await service(makeIo().io).startupSweep();
    await expect(lstat(orphan)).rejects.toThrow();
    expect((await stat(await adapterRelease())).isDirectory()).toBe(true);
  });
});
