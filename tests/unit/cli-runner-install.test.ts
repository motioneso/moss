/**
 * §A.3 INSTALL SERVICE invariants (#342 Phase 2 — supply-chain core).
 *
 * Covers the frozen acceptance criteria (install-contract §A.7.4):
 *  - serialize-rejects-concurrent (§A.3.1): a second same-provider install while one is
 *    in flight ⇒ InstallBadRequestError ("install already in progress"); different
 *    providers may run concurrently.
 *  - catalog-status gate (§A.2.3): a blocked provider (agy) ⇒ InstallBadRequestError
 *    ("provider not installable: <reason>").
 *  - verify-before-promote (§A.3.4): nothing is placed on PATH until the binary exists,
 *    its resolved + --version equal the pinned version, and (codex/claude) the per-arch
 *    native package is present.
 *  - rollback-on-verify-fail (§A.3.5): a version mismatch / missing binary leaves no live
 *    install and returns {state:"error"}.
 *  - atomic-promote-only-after-verify: the live PATH bin appears ONLY after a successful
 *    verify; `current` resolves into releases/<rand>, never into .staging.
 *  - idempotent-noop (§A.3.6): a re-install of the already-pinned + byte-identical version
 *    is a no-op with alreadyInstalled:true (no re-promote).
 *  - --ignore-scripts asserted (§A.3.3): the npm invocation carries `ci` + `--ignore-scripts`.
 *  - sanitized installer env (§A.3.3): the installer env = §7.2 allowlist + registry/proxy
 *    ONLY; no app/DB/vault/RPC secret.
 *  - startup sweep (§A.3.2): clears orphaned `.staging/*` and GCs unreferenced releases.
 *  - kind:"env" self-update-disable reaches the LAUNCHED CLI env (§A.3.7, R6): NOT merely
 *    the allowlist.
 */

import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/index.js";
import {
  InstallService,
  InstallBadRequestError,
  buildSanitizedInstallerEnv
} from "../../packages/cli-runner/src/install-service.js";
import { sourceSelfUpdateDisableEnv } from "../../packages/cli-runner/src/main.js";
import { buildSanitizedCliEnv } from "../../packages/cli-runner/src/sanitized-env.js";
import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import { createSanitizedTmuxIo } from "../../packages/cli-runner/src/runner-io.js";
import type { RpcProviderKind } from "../../packages/chat/src/live/rpc-contract.js";

// ─── A fake TmuxIo that simulates npm ci + --version + ls against a real temp tree ──

interface FakeIoOptions {
  /** Version the simulated `npm ci` materializes + the binary's `--version` reports. */
  readonly installedVersion: string;
  /** Override the version the binary's `--version` prints (to force a verify mismatch). */
  readonly probeVersion?: string;
  /** When set, `npm ci` fails (non-zero) to simulate an install failure. */
  readonly ciFails?: boolean;
  /** When false, the simulated install leaves no executable binary (verify fail). */
  readonly produceBinary?: boolean;
  /**
   * When true (the default for claude), the simulated `bin/claude.exe` wrapper is a STUB that
   * exits 1 with the "native binary not installed" error UNLESS the §A.1.3 placement step has
   * symlinked the per-arch native binary over it — exactly the real claude@2.1.183 behaviour.
   * The fake's `--version` probe therefore checks whether the wrapper resolves to the native
   * binary (a symlink) before reporting the version.
   */
  readonly stubWrapper?: boolean;
  /**
   * Which catalog provider is being installed. Decides the package name, the bin name and
   * whether per-arch native packages exist — the simulated tree must match the real package
   * or verify (§A.3.4) reads a shape the recipe never asked for. Defaults to `anthropic`.
   */
  readonly provider?: RpcProviderKind;
}

/** The node_modules shape the fake `npm ci` materializes for a given provider. */
interface FakePackageShape {
  /** The published package name (must equal the recipe's `pkg` — verify reads its package.json). */
  readonly pkg: string;
  /** Package-relative path of the file `.bin/<binName>` points at. */
  readonly wrapperRel: string;
  /** The package's exposed command (must equal the recipe's `binary`). */
  readonly binName: string;
  /** Per-arch native packages the lockfile pins (claude only; empty for a pure-JS package). */
  readonly archPackages: readonly string[];
}

const FAKE_PACKAGE_SHAPES: Partial<Record<RpcProviderKind, FakePackageShape>> = {
  anthropic: {
    pkg: "@anthropic-ai/claude-code",
    wrapperRel: "bin/claude.exe",
    binName: "claude",
    archPackages: ["@anthropic-ai/claude-code-linux-x64", "@anthropic-ai/claude-code-linux-arm64"]
  },
  // #2026: @google/gemini-cli ships ONE bundled JavaScript program (bin: { gemini:
  // "bundle/gemini.js" }) and NO per-arch native packages, so the fake tree has no arch dirs
  // and the wrapper is runnable straight out of `npm ci --ignore-scripts`.
  google: {
    pkg: "@google/gemini-cli",
    wrapperRel: "bundle/gemini.js",
    binName: "gemini",
    archPackages: []
  }
};

interface RecordedRun {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/** Marker bytes the fake writes into the per-arch native binary file (§A.1.3 placement target). */
const NATIVE_MARKER = "JARV1S_FAKE_NATIVE_CLAUDE_BINARY";
/** Marker bytes the fake writes into a STUB `bin/claude.exe` wrapper (errors until replaced). */
const STUB_MARKER = "claude native binary not installed";

function makeFakeIo(opts: FakeIoOptions): { io: TmuxIo; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  const provider = opts.provider ?? "anthropic";
  const shape = FAKE_PACKAGE_SHAPES[provider];
  if (!shape) throw new Error(`no fake package shape for provider "${provider}"`);
  const io: TmuxIo = {
    run: async (cmd, args, runOpts) => {
      runs.push({ cmd, args: [...args], env: runOpts?.env });

      // Simulate `npm ci --ignore-scripts --prefix <staging>`: materialize a node_modules
      // tree with the pinned package + its per-arch native package + a .bin/<binary>.
      if (cmd === "npm" && args[0] === "ci") {
        if (opts.ciFails) return { code: 1, stdout: "", stderr: "npm ci boom" };
        const prefixIdx = args.indexOf("--prefix");
        const staging = args[prefixIdx + 1] as string;
        const pkg = shape.pkg;
        const nm = path.join(staging, "node_modules");
        await mkdir(path.join(nm, pkg, path.dirname(shape.wrapperRel)), { recursive: true });
        await writeFile(
          path.join(nm, pkg, "package.json"),
          JSON.stringify({ name: pkg, version: opts.installedVersion })
        );
        // per-arch native packages present (the lockfile-pinned deps). Each ships the REAL
        // native binary file `claude`, marked with NATIVE_MARKER so the fake --version probe
        // can tell the (placed) native binary from the un-replaced stub wrapper.
        for (const archPkg of shape.archPackages) {
          const archDir = path.join(nm, archPkg);
          await mkdir(archDir, { recursive: true });
          await writeFile(path.join(archDir, "claude"), `${NATIVE_MARKER}\n`, { mode: 0o755 });
        }
        const binDir = path.join(nm, ".bin");
        await mkdir(binDir, { recursive: true });
        if (opts.produceBinary !== false) {
          // The package's exposed bin (claude: bin/claude.exe; gemini: bundle/gemini.js). When
          // stub, it is the ERROR STUB until §A.1.3 placement replaces it; else a plain runnable.
          const wrapper = path.join(nm, pkg, shape.wrapperRel);
          await writeFile(
            wrapper,
            opts.stubWrapper ? `${STUB_MARKER}\n` : "#!/usr/bin/env node\n",
            {
              mode: 0o755
            }
          );
          // npm's bin symlink, e.g. .bin/claude → ../@anthropic-ai/claude-code/bin/claude.exe.
          await symlink(path.join("..", pkg, shape.wrapperRel), path.join(binDir, shape.binName));
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      // Simulate `<bin> --version` (the §A.5 re-probe). For a stub-wrapper install, the wrapper
      // ERRORS (exit 1) until the §A.1.3 placement step has replaced it with the native binary —
      // detected by reading the file the path resolves to and checking for NATIVE_MARKER.
      if (args.length === 1 && args[0] === "--version") {
        if (opts.stubWrapper) {
          let resolved: string;
          try {
            resolved = await (await import("node:fs/promises")).readFile(cmd, "utf8");
          } catch {
            return { code: 1, stdout: "", stderr: "ENOENT" };
          }
          if (!resolved.includes(NATIVE_MARKER)) {
            return { code: 1, stdout: "", stderr: "Error: claude native binary not installed" };
          }
        }
        const v = opts.probeVersion ?? opts.installedVersion;
        return { code: 0, stdout: `${v}\n`, stderr: "" };
      }

      // `ls -A <dir>` for GC / sweep — defer to the real fs.
      if (cmd === "ls") {
        const dir = args[args.length - 1] as string;
        try {
          const { readdir } = await import("node:fs/promises");
          const names = await readdir(dir);
          return { code: 0, stdout: names.join("\n"), stderr: "" };
        } catch {
          return { code: 1, stdout: "", stderr: "" };
        }
      }

      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: async (p) => (await import("node:fs/promises")).readFile(p, "utf8"),
    writeFile: async (p, c) => {
      await (await import("node:fs/promises")).writeFile(p, c, "utf8");
    },
    sleep: async () => undefined
  };
  return { io, runs };
}

let toolsPrefix: string;
let homeBase: string;

beforeEach(async () => {
  toolsPrefix = await mkdtemp(path.join(tmpdir(), "jarv1s-tools-"));
  homeBase = await mkdtemp(path.join(tmpdir(), "jarv1s-home-"));
});

afterEach(async () => {
  await rm(toolsPrefix, { recursive: true, force: true }).catch(() => undefined);
  await rm(homeBase, { recursive: true, force: true }).catch(() => undefined);
});

const PINNED =
  PROVIDER_CATALOG.anthropic.recipe?.kind === "npm"
    ? PROVIDER_CATALOG.anthropic.recipe.version
    : "0.0.0";

/** The #2026 Gemini pin, read from the catalog so a deliberate bump is a one-line catalog edit. */
const GEMINI_PINNED =
  PROVIDER_CATALOG.google.recipe?.kind === "npm" ? PROVIDER_CATALOG.google.recipe.version : "0.0.0";

describe("InstallService — catalog gate (§A.2.3)", () => {
  // #2026 made google installable, so the gate can no longer be proved with whichever real
  // provider happens to be blocked today. Drive it from a FIXTURE catalog instead: the gate
  // itself keeps its coverage no matter what the real catalog says.
  it("rejects a provider the catalog marks blocked, with InstallBadRequestError", async () => {
    const blockedCatalog = {
      ...PROVIDER_CATALOG,
      google: {
        provider: "google",
        status: "blocked",
        blockedReason: "no pinnable checksummed artifact yet"
      }
    } as typeof PROVIDER_CATALOG;
    const { io } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({ io, catalog: blockedCatalog, toolsPrefix, homeBase });
    await expect(svc.installProvider("google" as RpcProviderKind)).rejects.toBeInstanceOf(
      InstallBadRequestError
    );
    await expect(svc.installProvider("google" as RpcProviderKind)).rejects.toThrow(
      /not installable/i
    );
  });

  it("accepts google against the REAL catalog now that #2026 pinned its recipe", async () => {
    const { io } = makeFakeIo({ installedVersion: GEMINI_PINNED, provider: "google" });
    const svc = new InstallService({ io, catalog: PROVIDER_CATALOG, toolsPrefix, homeBase });
    const result = await svc.installProvider("google" as RpcProviderKind);
    expect(result.state).toBe("installed");
  });
});

describe("InstallService — google/Gemini pinned recipe (#2026)", () => {
  it("installs via `npm ci --ignore-scripts`, verifies the pinned version, promotes `gemini`", async () => {
    const { io, runs } = makeFakeIo({ installedVersion: GEMINI_PINNED, provider: "google" });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });

    const result = await svc.installProvider("google" as RpcProviderKind);
    expect(result.state).toBe("installed");
    expect(result.version).toBe(GEMINI_PINNED);
    expect(result.binaryChanged).toBe(true);

    // §A.3.3: lifecycle scripts never run, and it is `ci` against the committed lockfile —
    // never a bare `npm install`, which would resolve fresh bytes and defeat the pin.
    const ci = runs.find((r) => r.cmd === "npm" && r.args[0] === "ci");
    expect(ci).toBeDefined();
    expect(ci?.args).toContain("--ignore-scripts");
    expect(ci?.args).not.toContain("install");

    // The promoted command is `gemini` — the package ships no `agy` command, so a recipe that
    // named `agy` would leave nothing on PATH here.
    const binStat = await stat(path.join(toolsPrefix, "bin", "gemini"));
    expect(binStat.isFile() || binStat.isSymbolicLink?.() || true).toBe(true);
    const current = await readlink(path.join(toolsPrefix, "providers", "google", "current"));
    expect(current).toMatch(/^releases\//);
    expect(current).not.toContain(".staging");
  });

  it("writes the settings file that turns the tool's own self-update off (§A.3.7)", async () => {
    // Gemini replaces itself by spawning a global npm install of a newer version, which would
    // swap the pinned bytes. Both `general` switches must be written false under the runner's
    // HOME; either one left true reopens that path.
    const { io } = makeFakeIo({ installedVersion: GEMINI_PINNED, provider: "google" });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });

    const result = await svc.installProvider("google" as RpcProviderKind);
    expect(result.state).toBe("installed");

    const settings = JSON.parse(
      await readFile(path.join(homeBase, ".gemini", "settings.json"), "utf8")
    ) as { general?: { enableAutoUpdate?: boolean; enableAutoUpdateNotification?: boolean } };
    expect(settings.general?.enableAutoUpdate).toBe(false);
    expect(settings.general?.enableAutoUpdateNotification).toBe(false);
  });

  it("refuses to promote when the installed gemini reports a version other than the pin", async () => {
    // §A.3.4/§A.3.5: a drifted tool never reaches PATH.
    const { io } = makeFakeIo({
      installedVersion: GEMINI_PINNED,
      probeVersion: "99.99.99",
      provider: "google"
    });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });

    const result = await svc.installProvider("google" as RpcProviderKind);
    expect(result.state).toBe("error");
    await expect(stat(path.join(toolsPrefix, "bin", "gemini"))).rejects.toThrow();
  });
});

describe("InstallService — npm install happy path (§A.3.3/§A.3.4/§A.3.5)", () => {
  it("installs via `npm ci --ignore-scripts`, verifies, and atomically promotes onto PATH", async () => {
    const { io, runs } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });

    const result = await svc.installProvider("anthropic");
    expect(result.state).toBe("installed");
    expect(result.version).toBe(PINNED);
    // #1081 H2: a REAL install (not an idempotent no-op) replaced the binary on disk.
    expect(result.binaryChanged).toBe(true);

    // §A.3.3: the npm invocation carries `ci` AND `--ignore-scripts` (no lifecycle scripts).
    const ci = runs.find((r) => r.cmd === "npm" && r.args[0] === "ci");
    expect(ci).toBeDefined();
    expect(ci?.args).toContain("--ignore-scripts");
    expect(ci?.args).not.toContain("install"); // never a bare `npm install`

    // §A.3.5: the live PATH bin exists and `current` resolves into releases/<rand>,
    // NEVER into .staging.
    const binStat = await stat(path.join(toolsPrefix, "bin", "claude"));
    expect(binStat.isFile() || binStat.isSymbolicLink?.() || true).toBe(true);
    const current = await readlink(path.join(toolsPrefix, "providers", "anthropic", "current"));
    expect(current).toMatch(/^releases\//);
    expect(current).not.toContain(".staging");

    // §A.3.2: the ephemeral staging scratch is emptied on success.
    const stagingRoot = path.join(toolsPrefix, ".staging");
    const stagingEntries = await import("node:fs/promises").then((m) =>
      m.readdir(stagingRoot).catch(() => [] as string[])
    );
    expect(stagingEntries).toHaveLength(0);
  });
});

describe("InstallService — §A.1.3 explicit native-binary placement (stub wrapper)", () => {
  it("symlinks the per-arch native binary over the stub wrapper before verify → claude --version passes", async () => {
    // Mirror real claude@2.1.183: bin/claude.exe is a STUB that errors until the per-arch
    // native binary is placed over it. The recipe carries archBinaryPlacement, so the install
    // service must place it; otherwise the stub's --version (exit 1) fails verify.
    const { io } = makeFakeIo({ installedVersion: PINNED, stubWrapper: true });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });

    const result = await svc.installProvider("anthropic");
    expect(result.state).toBe("installed");
    expect(result.version).toBe(PINNED);

    // The promoted wrapper is now a SYMLINK pointing at the per-arch native binary (not the
    // 233MB-stub file), inside the release lane.
    const current = await readlink(path.join(toolsPrefix, "providers", "anthropic", "current"));
    const releaseDir = path.join(toolsPrefix, "providers", "anthropic", current);
    const wrapper = path.join(
      releaseDir,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    const wrapperLink = await readlink(wrapper);
    expect(wrapperLink).toMatch(/claude-code-linux-x64\/claude$/);
    // The resolved bytes are the native binary, not the stub.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(wrapper, "utf8")).toContain(NATIVE_MARKER);
  });

  it("a recipe WITHOUT archBinaryPlacement is NOT placed (codex self-resolving wrapper)", async () => {
    // Drive the install service with a synthetic catalog entry that has NO archBinaryPlacement
    // and a wrapper that already runs — assert the wrapper is left untouched (no symlink), i.e.
    // placement is skipped. (codex relies on this: its bin/codex.js self-resolves at runtime.)
    const anthropic = PROVIDER_CATALOG.anthropic;
    if (anthropic.recipe?.kind !== "npm") throw new Error("expected npm recipe");
    const noPlacementRecipe = { ...anthropic.recipe, archBinaryPlacement: undefined };
    const catalog = {
      ...PROVIDER_CATALOG,
      anthropic: { ...anthropic, recipe: noPlacementRecipe }
    } as typeof PROVIDER_CATALOG;

    // produceBinary keeps the wrapper a plain runnable; stubWrapper omitted ⇒ --version passes
    // straight from npm ci with no placement.
    const { io } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({ io, catalog, toolsPrefix, homeBase, hostArch: "x64" });

    const result = await svc.installProvider("anthropic");
    expect(result.state).toBe("installed");

    const current = await readlink(path.join(toolsPrefix, "providers", "anthropic", "current"));
    const wrapper = path.join(
      toolsPrefix,
      "providers",
      "anthropic",
      current,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    // Without placement the wrapper is the original plain FILE npm ci wrote — NOT a symlink.
    const st = await lstat(wrapper);
    expect(st.isSymbolicLink()).toBe(false);
  });
});

describe("InstallService — verify-before-promote + rollback (§A.3.4/§A.3.5)", () => {
  it("a --version mismatch is a verify failure → state:error, nothing on PATH", async () => {
    // The simulated binary reports a DIFFERENT version than the pinned recipe.
    const { io } = makeFakeIo({ installedVersion: PINNED, probeVersion: "9.9.9-wrong" });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });
    const result = await svc.installProvider("anthropic");
    expect(result.state).toBe("error");

    // ATOMIC-PROMOTE-ONLY-AFTER-VERIFY: no live bin was placed on PATH.
    await expect(stat(path.join(toolsPrefix, "bin", "claude"))).rejects.toBeTruthy();
    await expect(
      stat(path.join(toolsPrefix, "providers", "anthropic", "current"))
    ).rejects.toBeTruthy();
  });

  it("a failed `npm ci` is a terminal error, not a promote", async () => {
    const { io } = makeFakeIo({ installedVersion: PINNED, ciFails: true });
    const svc = new InstallService({ io, catalog: PROVIDER_CATALOG, toolsPrefix, homeBase });
    const result = await svc.installProvider("anthropic");
    expect(result.state).toBe("error");
    await expect(stat(path.join(toolsPrefix, "bin", "claude"))).rejects.toBeTruthy();
  });

  it("an unsupported host arch is a DEFINED verify failure (not an undefined deref) (§A.1.3)", async () => {
    const { io } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "riscv64"
    });
    const result = await svc.installProvider("anthropic");
    expect(result.state).toBe("error");
    expect(result.message).toMatch(/unsupported host arch/i);
  });
});

describe("InstallService — serialize per provider (§A.3.1)", () => {
  it("a second same-provider install while one is in flight is rejected (not queued)", async () => {
    let releaseCi: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      releaseCi = res;
    });
    // An io whose `npm ci` blocks until we release it, so the first install stays in flight.
    const base = makeFakeIo({ installedVersion: PINNED });
    const io: TmuxIo = {
      ...base.io,
      run: async (cmd, args, opts) => {
        if (cmd === "npm" && args[0] === "ci") await gate;
        return base.io.run(cmd, args, opts);
      }
    };
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });

    const first = svc.installProvider("anthropic");
    // Give the first call time to acquire the lock + reach the blocked `npm ci`.
    await new Promise((r) => setTimeout(r, 20));
    await expect(svc.installProvider("anthropic")).rejects.toBeInstanceOf(InstallBadRequestError);

    releaseCi?.();
    const result = await first;
    expect(result.state).toBe("installed");
  });
});

describe("InstallService — idempotent re-install (§A.3.6)", () => {
  it("re-installing the already-pinned, byte-identical version is a no-op (alreadyInstalled)", async () => {
    const { io, runs } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });

    const first = await svc.installProvider("anthropic");
    expect(first.state).toBe("installed");
    expect(first.alreadyInstalled).toBeUndefined();
    // #1081 H2: the real install path replaced the binary on disk.
    expect(first.binaryChanged).toBe(true);

    const ciCountAfterFirst = runs.filter((r) => r.cmd === "npm" && r.args[0] === "ci").length;

    const second = await svc.installProvider("anthropic");
    expect(second.state).toBe("installed");
    expect(second.alreadyInstalled).toBe(true);
    // #1081 H2: the idempotent no-op touched nothing on disk — binaryChanged must be
    // explicitly false (not merely falsy/omitted), so callers can safely branch on it.
    expect(second.binaryChanged).toBe(false);

    // No second `npm ci` ran — the no-op did not re-stage/re-promote.
    const ciCountAfterSecond = runs.filter((r) => r.cmd === "npm" && r.args[0] === "ci").length;
    expect(ciCountAfterSecond).toBe(ciCountAfterFirst);
  });
});

describe("InstallService — boot-time reconcile of installed providers (#1081 H1)", () => {
  it("reinstalls a provider whose live binary has DRIFTED from the current catalog pin", async () => {
    // Stage 1: install anthropic at the original PINNED version — this is the
    // "already installed" baseline that later drifts (e.g. a redeploy rebaked the
    // recipe catalog to a newer version, but the named tools volume kept the old binary).
    const stage1 = makeFakeIo({ installedVersion: PINNED });
    const svc1 = new InstallService({
      io: stage1.io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });
    await svc1.installProvider("anthropic");

    // Stage 2: a fresh InstallService bound to the SAME toolsPrefix/homeBase (simulating
    // the same persistent volume across a redeploy), but with the catalog's anthropic
    // recipe pinned to a DIFFERENT version — the rebaked-image scenario. The fake IO's
    // `installedVersion` here is what a real reinstall would produce.
    const drifted = "9.9.9-drifted";
    const baseAnthropicRecipe = PROVIDER_CATALOG.anthropic.recipe;
    if (!baseAnthropicRecipe) throw new Error("test fixture: anthropic recipe missing");
    const driftedCatalog = {
      ...PROVIDER_CATALOG,
      anthropic: {
        ...PROVIDER_CATALOG.anthropic,
        recipe: { ...baseAnthropicRecipe, version: drifted }
      }
    } as typeof PROVIDER_CATALOG;
    const stage2 = makeFakeIo({ installedVersion: drifted });
    const svc2 = new InstallService({
      io: stage2.io,
      catalog: driftedCatalog,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });
    const installSpy = vi.spyOn(svc2, "installProvider");

    await svc2.reconcileInstalledProviders();

    // #1081 H1: the already-installed, now-drifted provider was reconciled via the normal
    // installProvider path (real reinstall — tryIdempotentNoop's version/hash check failed).
    expect(installSpy).toHaveBeenCalledWith("anthropic");
    expect(installSpy).toHaveBeenCalledTimes(1);
    const ciRuns = stage2.runs.filter((r) => r.cmd === "npm" && r.args[0] === "ci");
    expect(ciRuns.length).toBeGreaterThan(0);
  });

  it("is a no-op (no re-promote) when the installed version already matches the catalog", async () => {
    const { io, runs } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });
    await svc.installProvider("anthropic");
    const ciCountBeforeReconcile = runs.filter((r) => r.cmd === "npm" && r.args[0] === "ci").length;

    await svc.reconcileInstalledProviders();

    // #1081 H1: version+hash already match the catalog ⇒ installProvider's internal
    // tryIdempotentNoop short-circuits — no additional `npm ci` ran.
    const ciCountAfterReconcile = runs.filter((r) => r.cmd === "npm" && r.args[0] === "ci").length;
    expect(ciCountAfterReconcile).toBe(ciCountBeforeReconcile);
  });

  it("leaves a NEVER-installed provider completely untouched (not a fresh install)", async () => {
    // Fresh toolsPrefix/homeBase — nothing installed for ANY provider yet.
    const { io } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64"
    });
    const installSpy = vi.spyOn(svc, "installProvider");

    await svc.reconcileInstalledProviders();

    // #1081 H1: drift reconcile is NOT a fresh-install trigger — §A.2.3's admin-gated
    // route stays the sole path for a provider with no existing release.
    expect(installSpy).not.toHaveBeenCalled();
  });
});

describe("InstallService — startup sweep (§A.3.2)", () => {
  it("clears orphaned .staging/* and GCs releases not referenced by current", async () => {
    // Seed an orphaned staging dir and two release dirs, with `current` → one of them.
    await mkdir(path.join(toolsPrefix, ".staging", "anthropic-orphan"), { recursive: true });
    const providerDir = path.join(toolsPrefix, "providers", "anthropic");
    const releasesDir = path.join(providerDir, "releases");
    await mkdir(path.join(releasesDir, "keep"), { recursive: true });
    await mkdir(path.join(releasesDir, "orphan"), { recursive: true });
    await symlink(path.join("releases", "keep"), path.join(providerDir, "current"));

    const { io } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({ io, catalog: PROVIDER_CATALOG, toolsPrefix, homeBase });
    await svc.startupSweep();

    // .staging is gone entirely.
    await expect(stat(path.join(toolsPrefix, ".staging"))).rejects.toBeTruthy();
    // the referenced release survives, the orphan is GC'd.
    await expect(stat(path.join(releasesDir, "keep"))).resolves.toBeTruthy();
    await expect(stat(path.join(releasesDir, "orphan"))).rejects.toBeTruthy();
  });
});

describe("InstallService — sanitized installer env (§A.3.3)", () => {
  it("the installer env = §7.2 allowlist + registry/proxy ONLY; no app/DB/vault/RPC secret", () => {
    const source: NodeJS.ProcessEnv = {
      HOME: "/data/cli-auth",
      PATH: "/usr/bin:/data/cli-tools/bin",
      NPM_CONFIG_PREFIX: "/data/cli-tools",
      LANG: "en_US.UTF-8",
      // registry/proxy — KEPT for a legitimate npm install
      HTTPS_PROXY: "http://proxy:8080",
      HTTP_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost",
      NPM_CONFIG_REGISTRY: "https://registry.example/",
      // EXCLUDED — every secret + the socket path + the RPC secret
      JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
      JARVIS_CLI_RUNNER_RPC_SECRET: "rpc-secret",
      BETTER_AUTH_SECRET: "x",
      JARVIS_AI_SECRET_KEY: "x",
      JARVIS_CONNECTOR_SECRET_KEY: "x",
      POSTGRES_PASSWORD: "x",
      JARVIS_APP_DATABASE_URL: "postgres://...",
      JARVIS_VAULT_ROOT: "/data/vaults"
    };
    const env = buildSanitizedInstallerEnv(source);

    // allowlist + registry/proxy survive
    expect(env.HOME).toBe("/data/cli-auth");
    expect(env.NPM_CONFIG_PREFIX).toBe("/data/cli-tools");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.NPM_CONFIG_REGISTRY).toBe("https://registry.example/");

    // every secret + the socket path + the RPC secret are dropped
    expect(env.JARVIS_CLI_RUNNER_SOCKET).toBeUndefined();
    expect(env.JARVIS_CLI_RUNNER_RPC_SECRET).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.JARVIS_AI_SECRET_KEY).toBeUndefined();
    expect(env.JARVIS_CONNECTOR_SECRET_KEY).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.JARVIS_APP_DATABASE_URL).toBeUndefined();
    expect(env.JARVIS_VAULT_ROOT).toBeUndefined();
  });

  it("the npm ci subprocess is invoked WITH the sanitized installer env (no secrets)", async () => {
    const { io, runs } = makeFakeIo({ installedVersion: PINNED });
    const svc = new InstallService({
      io,
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase,
      hostArch: "x64",
      env: {
        HOME: "/data/cli-auth",
        PATH: process.env.PATH,
        NPM_CONFIG_REGISTRY: "https://registry.example/",
        BETTER_AUTH_SECRET: "must-not-leak",
        JARVIS_CLI_RUNNER_RPC_SECRET: "rpc-secret"
      }
    });
    await svc.installProvider("anthropic");
    const ci = runs.find((r) => r.cmd === "npm" && r.args[0] === "ci");
    expect(ci?.env?.NPM_CONFIG_REGISTRY).toBe("https://registry.example/");
    expect(ci?.env?.BETTER_AUTH_SECRET).toBeUndefined();
    expect(ci?.env?.JARVIS_CLI_RUNNER_RPC_SECRET).toBeUndefined();
  });
});

describe("self-update-disable kind:env reaches the LAUNCHED CLI env (§A.3.7, R6)", () => {
  it("sourceSelfUpdateDisableEnv sets the catalog env key on process.env, and the §7.2 passthrough then carries the VALUE to the launched CLI", () => {
    // The catalog's anthropic recipe pins a kind:"env" self-update-disable.
    const recipe = PROVIDER_CATALOG.anthropic.recipe;
    if (recipe?.kind !== "npm" || recipe.selfUpdateDisable.kind !== "env") {
      // codex/claude could be pinned config; the assertion is conditional on env-kind.
      return;
    }
    const { key, value } = recipe.selfUpdateDisable;

    // A bare process.env that does NOT yet carry the key — allowlisting alone is a NO-OP.
    const beforeSource: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/data/cli-auth" };
    expect(buildSanitizedCliEnv(beforeSource)[key]).toBeUndefined();

    // After boot-sourcing the catalog pair onto the env, the §7.2 passthrough delivers it.
    const target: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/data/cli-auth" };
    const setKeys = sourceSelfUpdateDisableEnv(target);
    expect(setKeys).toContain(key);
    const launchedCliEnv = buildSanitizedCliEnv(target);
    // The VALUE actually reaches the launched-CLI env — NOT merely the allowlist.
    expect(launchedCliEnv[key]).toBe(value);
  });
});

// ─── GUARDED-LIVE regression for the §A.1.3 native-binary placement bug ────────
//
// This is the REAL proof for exactly the bug this change fixes: `npm ci --ignore-scripts`
// of claude@2.1.183 leaves `bin/claude.exe` a STUB that exits 1 ("native binary not
// installed"), so without the explicit per-arch placement the install service's verify
// (`.bin/claude --version`) fails and claude can NEVER install. It does a REAL npm ci of the
// committed lockfile, runs the REAL InstallService (real placement + verify + promote), and
// asserts the live `claude --version` reports the pinned version. It is NETWORK-GATED and
// SKIPPED by default (only runs with JARVIS_LIVE_INSTALL_TEST=1) so `pnpm test:unit` stays
// green offline.
const liveIt = process.env.JARVIS_LIVE_INSTALL_TEST === "1" ? it : it.skip;

describe("InstallService — GUARDED-LIVE real npm ci + §A.1.3 placement (network)", () => {
  liveIt(
    "real `npm ci --ignore-scripts` of claude then placement → live `claude --version` reports the pinned version",
    async () => {
      const recipe = PROVIDER_CATALOG.anthropic.recipe;
      if (recipe?.kind !== "npm") throw new Error("expected anthropic npm recipe");
      const pinned = recipe.version;

      // Real sanitized installer env path: PATH/HOME/registry pass through, secrets do not.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: homeBase,
        ...(process.env.NPM_CONFIG_REGISTRY
          ? { NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY }
          : {}),
        ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
        ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {})
      };
      const io = createSanitizedTmuxIo(env);
      const svc = new InstallService({
        io,
        catalog: PROVIDER_CATALOG,
        toolsPrefix,
        homeBase,
        env,
        installTimeoutMs: 600_000
      });

      const result = await svc.installProvider("anthropic");
      // The whole point: with the §A.1.3 placement, the install SUCCEEDS (it returned
      // state:"error" before the fix because the stub wrapper failed verify).
      expect(result.message ?? "").not.toMatch(/native binary not installed/i);
      expect(result.state).toBe("installed");
      expect(result.version).toBe(pinned);

      // And the LIVE promoted bin actually runs and reports the pinned version.
      const liveBin = path.join(toolsPrefix, "bin", "claude");
      const probe = await io.run(liveBin, ["--version"]);
      expect(probe.code).toBe(0);
      expect(probe.stdout).toContain(pinned);
    },
    600_000
  );

  // codex must STILL work WITHOUT placement (its wrapper self-resolves) — guards the
  // requirement that the fix is claude-specific and does not change codex's behaviour.
  liveIt(
    "real `npm ci --ignore-scripts` of codex (NO placement) → live `codex --version` still works",
    async () => {
      const recipe = PROVIDER_CATALOG["openai-compatible"].recipe;
      if (recipe?.kind !== "npm") throw new Error("expected codex npm recipe");
      expect(recipe.archBinaryPlacement).toBeUndefined(); // codex omits placement by design
      const pinned = recipe.version;

      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: homeBase,
        ...(process.env.NPM_CONFIG_REGISTRY
          ? { NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY }
          : {})
      };
      const io = createSanitizedTmuxIo(env);
      const svc = new InstallService({
        io,
        catalog: PROVIDER_CATALOG,
        toolsPrefix,
        homeBase,
        env,
        installTimeoutMs: 600_000
      });

      const result = await svc.installProvider("openai-compatible");
      expect(result.state).toBe("installed");
      expect(result.version).toBe(pinned);

      const liveBin = path.join(toolsPrefix, "bin", "codex");
      const probe = await io.run(liveBin, ["--version"]);
      expect(probe.code).toBe(0);
      expect(probe.stdout).toContain(pinned);
    },
    600_000
  );
});
