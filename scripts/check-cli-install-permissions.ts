import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TmuxIo } from "../packages/ai/src/index.js";
import { PROVIDER_CATALOG } from "../packages/cli-runner/src/catalog.js";
import { InstallService } from "../packages/cli-runner/src/install-service.js";
import { buildSetprivDropCommand } from "../packages/cli-runner/src/setpriv.js";
import type { RpcProviderKind } from "../packages/chat/src/live/rpc-contract.js";

const SCRIPT = fileURLToPath(import.meta.url);
const LAUNCHER_UID = 1000;
const OWNER_A = 100001;
const OWNER_B = 100002;
const PROVIDER = "openai-compatible" as RpcProviderKind;
const recipe = PROVIDER_CATALOG[PROVIDER].recipe;
assert(recipe?.kind === "npm");
const VERSION = recipe.version;
const PKG = "@openai/codex";
const ARCH_PKG = "@openai/codex-linux-x64";

type Mode =
  | "protected"
  | "negative-shared-write"
  | "negative-credential-read"
  | "negative-staging-access";

const CAP_CHOWN = 1n << 0n;
const CAP_SETGID = 1n << 6n;
const CAP_SETUID = 1n << 7n;
const CAP_FOWNER = 1n << 3n;
const CAP_KILL = 1n << 5n;
const LAUNCHER_CAP_MASK = CAP_CHOWN | CAP_SETGID | CAP_SETUID;
const ROOT_CAP_MASK = LAUNCHER_CAP_MASK | CAP_FOWNER | CAP_KILL;

function procStatus(): string {
  return readFileSync(`/proc/${process.pid}/status`, "utf8");
}

function procField(name: string): string {
  return (
    procStatus()
      .split("\n")
      .find((line) => line.startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim() ?? ""
  );
}

function capability(name: string): bigint {
  return BigInt(`0x${procField(name)}`);
}

function requireRoot(): void {
  assert.equal(
    process.getuid?.(),
    0,
    "this diagnostic must run as root in the disposable container"
  );
  assert.equal(
    process.getgid?.(),
    0,
    "this diagnostic must run as root in the disposable container"
  );
  assert(existsSync("/.dockerenv"), "this diagnostic must run in its disposable container");
  assert.equal(procField("NoNewPrivs"), "1", "container must set no-new-privileges");
  for (const field of ["CapPrm", "CapEff", "CapInh", "CapAmb"]) {
    assert.equal(
      capability(field) & ~ROOT_CAP_MASK,
      0n,
      `${field} contains an unexpected container capability`
    );
  }
}

function command(command: string, args: string[], uid?: number) {
  const actualCommand = uid === undefined ? command : "setpriv";
  const actualArgs =
    uid === undefined
      ? args
      : [
          `--reuid=${uid}`,
          `--regid=${uid}`,
          "--clear-groups",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--",
          command,
          ...args
        ];
  const result = spawnSync(actualCommand, actualArgs, {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp" }
  });
  return result;
}

function runAsLauncher(base: string, mode: Mode) {
  return command("setpriv", [
    `--reuid=${LAUNCHER_UID}`,
    `--regid=${LAUNCHER_UID}`,
    "--clear-groups",
    "--inh-caps=+chown,+setuid,+setgid",
    "--ambient-caps=+chown,+setuid,+setgid",
    "--",
    process.execPath,
    "--import",
    "tsx",
    SCRIPT,
    "--launcher",
    base,
    mode
  ]);
}

function assertLauncher(): void {
  assert.equal(process.getuid?.(), LAUNCHER_UID);
  assert.equal(process.getgid?.(), LAUNCHER_UID);
  assert.equal(procField("Groups"), "", "launcher retained supplementary groups");
  for (const name of ["CapPrm", "CapEff", "CapInh", "CapAmb"]) {
    assert.equal(
      capability(name) & ~LAUNCHER_CAP_MASK,
      0n,
      `${name} contains an unexpected launcher capability`
    );
  }
}

function ownerProbe(base: string, uid: number, pathToCheck: string, mode: Mode): string[] {
  assert.equal(process.getuid?.(), uid);
  assert.equal(process.getgid?.(), uid);
  assert.equal(procField("Groups"), "");
  for (const name of ["CapPrm", "CapEff", "CapInh", "CapAmb"]) {
    assert.equal(procField(name), "0000000000000000", `${name} was not dropped`);
  }
  const failures: string[] = [];
  const home = path.join(base, "home", uid === OWNER_A ? "a" : "b");
  const ownCredential = path.join(home, ".codex", "auth.json");
  const otherCredential = path.join(
    base,
    "home",
    uid === OWNER_A ? "b" : "a",
    ".codex",
    "auth.json"
  );
  assert.equal(JSON.parse(readFileSync(ownCredential, "utf8")).owner, uid);
  const credentialStat = statSync(ownCredential);
  assert.equal(credentialStat.uid, uid);
  assert.equal(credentialStat.gid, uid);
  assert.equal(credentialStat.mode & 0o777, mode === "negative-credential-read" ? 0o644 : 0o600);
  try {
    readFileSync(otherCredential);
    failures.push("cross-account credential read was allowed");
  } catch {
    // expected: credentials are owner-readable only
  }

  const expectDenied = (name: string, action: () => void) => {
    try {
      action();
      failures.push(name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") {
        failures.push(`${name} failed with ${code ?? "unknown error"}`);
      }
    }
  };
  const version = spawnSync(pathToCheck, ["--version"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: home }
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `${VERSION}\n`);
  const providerDir = path.join(base, "tools", "providers", PROVIDER);
  const release = path.resolve(providerDir, readlinkSync(path.join(providerDir, "current")));
  const releaseEntry = path.join(path.dirname(release), `release-entry-copy-${uid}`);
  const currentCopy = path.join(providerDir, `current-copy-${uid}`);
  const stableCopy = path.join(path.dirname(pathToCheck), `codex-copy-${uid}`);
  expectDenied("installed executable write was allowed", () =>
    writeFileSync(pathToCheck, readFileSync(pathToCheck))
  );
  expectDenied("release-root write was allowed", () =>
    writeFileSync(path.join(release, `.probe-${uid}`), "changed\n")
  );
  expectDenied("release entry unlink was allowed", () => unlinkSync(releaseEntry));
  expectDenied("current symlink unlink was allowed", () => unlinkSync(currentCopy));
  expectDenied("stable binary symlink unlink was allowed", () => unlinkSync(stableCopy));
  return failures;
}

function prepareWriteTargets(
  providerDir: string,
  release: string,
  stable: string,
  uid: number
): void {
  const releaseEntry = path.join(path.dirname(release), `release-entry-copy-${uid}`);
  const currentCopy = path.join(providerDir, `current-copy-${uid}`);
  const stableCopy = path.join(path.dirname(stable), `codex-copy-${uid}`);
  for (const target of [releaseEntry, currentCopy, stableCopy]) rmSync(target, { force: true });
  symlinkSync(path.basename(release), releaseEntry);
  symlinkSync("current", currentCopy);
  symlinkSync("codex", stableCopy);
}

function runOwnerChecks(
  base: string,
  providerDir: string,
  release: string,
  stable: string,
  mode: Mode,
  failures: string[],
  expectNegative = false
): void {
  for (const uid of [OWNER_A, OWNER_B]) {
    prepareWriteTargets(providerDir, release, stable, uid);
    const result = runAsOwner(base, uid, stable, mode);
    if (mode === "protected" || !expectNegative) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } else {
      assert.notEqual(result.status, 0, `${mode} owner ${uid} unexpectedly passed`);
    }
    for (const line of result.stdout.split("\n").filter(Boolean)) failures.push(line);
    if (result.status !== 0 && result.stderr.trim()) {
      failures.push(`uid ${uid} child failed: ${result.stderr.trim()}`);
    }
  }
}

function runAsOwner(base: string, uid: number, pathToCheck: string, mode: Mode) {
  const drop = buildSetprivDropCommand(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--owner", base, String(uid), pathToCheck, mode],
    { uid, gid: uid }
  );
  return command(drop.command, drop.args);
}

function createFixture(base: string, mode: Mode): void {
  const tools = path.join(base, "tools");
  const home = path.join(base, "home");
  mkdirSync(path.join(tools, "bin"), { recursive: true, mode: 0o755 });
  mkdirSync(home, { mode: 0o755 });
  for (const [name, uid] of [
    ["a", OWNER_A],
    ["b", OWNER_B]
  ] as const) {
    const codex = path.join(home, name, ".codex");
    mkdirSync(codex, { recursive: true, mode: 0o700 });
    chmodSync(codex, 0o755);
    writeFileSync(path.join(codex, "auth.json"), JSON.stringify({ owner: uid }));
    const credentialOpen = mode === "negative-credential-read";
    chmodSync(path.join(codex, "auth.json"), credentialOpen ? 0o644 : 0o600);
    chmodSync(codex, credentialOpen ? 0o755 : 0o700);
    chmodSync(path.join(home, name), credentialOpen ? 0o755 : 0o700);
    chownSync(path.join(codex, "auth.json"), uid, uid);
    chownSync(codex, uid, uid);
    chownSync(path.join(home, name), uid, uid);
  }
  chownSync(tools, LAUNCHER_UID, LAUNCHER_UID);
  chownSync(path.join(tools, "bin"), LAUNCHER_UID, LAUNCHER_UID);
  chownSync(home, LAUNCHER_UID, LAUNCHER_UID);
}

function makeIo(
  base: string,
  mode: Mode,
  failures: string[],
  failPublication = false,
  publicationFailure?: { injected: boolean }
): TmuxIo {
  let publicationStaging: string | undefined;
  return {
    run: async (cmd, args) => {
      if (cmd === "npm" && args[0] === "ci") {
        const staging = args[args.indexOf("--prefix") + 1]!;
        publicationStaging = staging;
        const stagingRoot = path.dirname(staging);
        if (mode === "negative-staging-access") {
          chmodSync(stagingRoot, 0o755);
          chmodSync(staging, 0o755);
        }
        for (const uid of [OWNER_A, OWNER_B]) {
          const probe = command("test", ["-r", staging], uid);
          if (probe.status === 0) failures.push(`staging access allowed for uid ${uid}`);
        }
        const nm = path.join(staging, "node_modules");
        const pkgDir = path.join(nm, PKG, "bin");
        const archDir = path.join(nm, ARCH_PKG);
        mkdirSync(pkgDir, { recursive: true });
        mkdirSync(archDir, { recursive: true });
        writeFileSync(
          path.join(nm, PKG, "package.json"),
          JSON.stringify({ name: PKG, version: VERSION })
        );
        writeFileSync(path.join(archDir, "codex"), `#!/bin/sh\necho ${VERSION}\n`, { mode: 0o755 });
        writeFileSync(path.join(pkgDir, "codex.js"), `#!/bin/sh\necho ${VERSION}\n`, {
          mode: 0o755
        });
        const binDir = path.join(nm, ".bin");
        mkdirSync(binDir, { recursive: true });
        symlinkSync(path.join("..", PKG, "bin", "codex.js"), path.join(binDir, "codex"));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "ls") {
        try {
          return { code: 0, stdout: readdirSync(args.at(-1)!).join("\n"), stderr: "" };
        } catch {
          return { code: 1, stdout: "", stderr: "" };
        }
      }
      if (args[0] === "--version") {
        if (failPublication && publicationStaging && !publicationFailure?.injected) {
          // Keep verification readable, then make the real promote chmod fail because the
          // launcher no longer owns the staged root. This runs during verify's --version
          // probe, immediately before promoteNpm, so the failure reaches its publication
          // permission operation rather than stopping staging or verification early.
          chmodSync(publicationStaging, 0o755);
          chownSync(publicationStaging, OWNER_A, OWNER_A);
          if (publicationFailure) publicationFailure.injected = true;
        }
        const result = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
        return {
          code: result.status ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? ""
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    sleep: async () => undefined,
    readFile: async (file) => readFileSync(file, "utf8"),
    writeFile: async (file, content) => writeFileSync(file, content, "utf8")
  };
}

async function launcher(base: string, mode: Mode): Promise<void> {
  assertLauncher();
  const tools = path.join(base, "tools");
  const failures: string[] = [];
  const service = () =>
    new InstallService({
      io: makeIo(base, mode, failures),
      catalog: PROVIDER_CATALOG,
      toolsPrefix: tools,
      homeBase: path.join(base, "home"),
      hostArch: "x64"
    });
  const first = service();
  const firstResult = await first.installProvider(PROVIDER);
  assert.equal(firstResult.state, "installed", JSON.stringify(firstResult));
  const providerDir = path.join(tools, "providers", PROVIDER);
  const firstTarget = readlinkSync(path.join(providerDir, "current"));
  const firstRelease = path.resolve(providerDir, firstTarget);
  assert.equal(statSync(firstRelease).mode & 0o777, 0o755);
  const stable = path.join(tools, "bin", "codex");
  runOwnerChecks(
    base,
    providerDir,
    firstRelease,
    stable,
    mode,
    failures,
    mode === "negative-credential-read"
  );

  const second = service();
  const secondResult = await second.installProvider(PROVIDER);
  assert.equal(secondResult.state, "installed", JSON.stringify(secondResult));
  const secondTarget = readlinkSync(path.join(providerDir, "current"));
  assert.notEqual(secondTarget, firstTarget, "fresh service did not replace the release");
  const secondRelease = path.resolve(providerDir, secondTarget);
  assert.equal(statSync(secondRelease).mode & 0o777, 0o755);
  runOwnerChecks(
    base,
    providerDir,
    secondRelease,
    stable,
    mode,
    failures,
    mode === "negative-credential-read"
  );

  const priorBytes = readFileSync(stable);
  const publicationFailure = { injected: false };
  const failedPublication = new InstallService({
    io: makeIo(base, mode, failures, true, publicationFailure),
    catalog: PROVIDER_CATALOG,
    toolsPrefix: tools,
    homeBase: path.join(base, "home"),
    hostArch: "x64"
  });
  const failedResult = await failedPublication.installProvider(PROVIDER);
  assert.equal(failedResult.state, "error", JSON.stringify(failedResult));
  assert.equal(
    publicationFailure.injected,
    true,
    "simulated publication failure did not reach promoteNpm"
  );
  assert.equal(readlinkSync(path.join(providerDir, "current")), secondTarget);
  assert.deepEqual(readFileSync(stable), priorBytes);
  runOwnerChecks(
    base,
    providerDir,
    secondRelease,
    stable,
    mode,
    failures,
    mode === "negative-credential-read"
  );

  chmodSync(secondRelease, 0o700);
  await second.startupSweep();
  await second.reconcileInstalledProviders();
  const sameProcessTarget = readlinkSync(path.join(providerDir, "current"));
  assert.notEqual(
    sameProcessTarget,
    secondTarget,
    "startup reconciliation accepted legacy permissions"
  );
  const sameProcessRelease = path.resolve(providerDir, sameProcessTarget);
  assert.equal(statSync(sameProcessRelease).mode & 0o777, 0o755);
  runOwnerChecks(
    base,
    providerDir,
    sameProcessRelease,
    stable,
    mode,
    failures,
    mode === "negative-credential-read"
  );

  chmodSync(sameProcessRelease, 0o700);
  const freshProcess = service();
  await freshProcess.startupSweep();
  await freshProcess.reconcileInstalledProviders();
  const repairedTarget = readlinkSync(path.join(providerDir, "current"));
  assert.notEqual(
    repairedTarget,
    sameProcessTarget,
    "fresh-process recovery accepted legacy permissions"
  );
  const repairedRelease = path.resolve(providerDir, repairedTarget);
  assert.equal(statSync(repairedRelease).mode & 0o777, 0o755);
  runOwnerChecks(
    base,
    providerDir,
    repairedRelease,
    stable,
    mode,
    failures,
    mode === "negative-credential-read"
  );
  const healthyTarget = repairedTarget;
  await freshProcess.reconcileInstalledProviders();
  assert.equal(readlinkSync(path.join(providerDir, "current")), healthyTarget);
  runOwnerChecks(
    base,
    providerDir,
    repairedRelease,
    stable,
    mode,
    failures,
    mode === "negative-credential-read"
  );

  if (mode === "negative-shared-write") {
    chmodSync(path.join(tools, "bin"), 0o777);
    chmodSync(providerDir, 0o777);
    chmodSync(path.join(providerDir, "releases"), 0o777);
    chmodSync(repairedRelease, 0o777);
    chmodSync(stable, 0o777);
  }
  runOwnerChecks(
    base,
    providerDir,
    repairedRelease,
    stable,
    mode,
    failures,
    mode === "negative-shared-write" || mode === "negative-credential-read"
  );
  if (mode === "negative-shared-write") {
    for (const name of [
      "installed executable write was allowed",
      "release-root write was allowed",
      "release entry unlink was allowed",
      "current symlink unlink was allowed",
      "stable binary symlink unlink was allowed"
    ])
      assert(
        failures.some((failure) => failure.startsWith(name)),
        `missing shared-write assertion: ${name}`
      );
  } else if (mode === "negative-credential-read") {
    assert(
      failures.some((failure) => failure.startsWith("cross-account credential read was allowed")),
      "missing credential-read assertion"
    );
  } else if (mode === "negative-staging-access") {
    assert(
      failures.some((failure) => failure.startsWith("staging access allowed")),
      "missing staging-access assertion"
    );
  }
  assert.equal(failures.length, 0, failures.join("; "));
}

function parseMode(arg: string | undefined): Mode {
  if (arg === undefined || arg === "protected") return "protected";
  if (
    arg === "--negative-shared-write" ||
    arg === "--negative-credential-read" ||
    arg === "--negative-staging-access"
  ) {
    return arg.slice(2) as Mode;
  }
  throw new Error(`unknown mode ${arg}; expected a documented --negative-* flag`);
}

async function main(): Promise<void> {
  requireRoot();
  const mode = parseMode(process.argv[2]);
  const base = mkdtempSync(path.join(tmpdir(), "moss-cli-install-permissions-"));
  try {
    chmodSync(base, 0o755);
    createFixture(base, mode);
    const result = runAsLauncher(base, mode);
    if (mode === "protected") {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      console.log(
        "protected install, replacement, startup repair, identity and denial checks passed"
      );
    } else {
      assert.notEqual(result.status, 0, `${mode} unexpectedly passed`);
      assert(result.stderr.trim(), `${mode} produced no failing assertion output`);
      console.log(`${mode} failed as expected:\n${result.stderr.trim().slice(0, 2000)}`);
      process.exitCode = 1;
    }
  } finally {
    // The image deliberately removes DAC_OVERRIDE. The launcher owns the fixture's nested
    // files, so a root cleanup without that capability is not reliable; the disposable
    // container removes /tmp with its normal lifecycle.
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* container cleanup */
    }
  }
}

if (process.argv[2] === "--launcher") {
  await launcher(process.argv[3]!, process.argv[4] as Mode);
} else if (process.argv[2] === "--owner") {
  const failures = ownerProbe(
    process.argv[3]!,
    Number(process.argv[4]),
    process.argv[5]!,
    process.argv[6] as Mode
  );
  for (const failure of failures) console.log(failure);
  process.exitCode = failures.length === 0 ? 0 : 1;
} else {
  await main();
}
