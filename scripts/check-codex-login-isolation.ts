import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
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
import { fileURLToPath } from "node:url";

import { AcpHost } from "../packages/cli-runner/src/acp-host.js";
import { LOGIN_ADAPTERS } from "../packages/cli-runner/src/login-adapters.js";
import { LoginService } from "../packages/cli-runner/src/login-service.js";
import type { TmuxIo } from "../packages/ai/src/adapters/tmux-bridge.js";

const LAUNCHER_UID = 1000;
const OWNER_UID = 100001;
const OTHER_UID = 100002;
const LAUNCHER_CAPS = "+chown,+setuid,+setgid";
const CAP_CHOWN = 1n << 0n;
const CAP_SETGID = 1n << 6n;
const CAP_SETUID = 1n << 7n;
const LAUNCHER_CAP_MASK = CAP_CHOWN | CAP_SETGID | CAP_SETUID;
const SCRIPT = fileURLToPath(import.meta.url);
const SYNTHETIC_AUTH = JSON.stringify({
  tokens: { access_token: "synthetic-access", account_id: "synthetic-account" }
});

function requireDisposableRoot(): void {
  if (process.getuid?.() !== 0) {
    throw new Error(
      "check-codex-login-isolation must run as root in the disposable capability-limited container"
    );
  }
}

function procStatus(): string {
  return readFileSync(`/proc/${process.pid}/status`, "utf8");
}

function procField(name: string): string {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(procStatus());
  assert(match, `missing /proc status field ${name}`);
  return match[1]!.trim();
}

function capability(name: string): bigint {
  return BigInt(`0x${procField(name)}`);
}

function assertLauncherIdentity(): void {
  assert.equal(process.getuid?.(), LAUNCHER_UID);
  assert.equal(process.getgid?.(), LAUNCHER_UID);
  for (const field of ["CapPrm", "CapEff", "CapInh", "CapAmb"]) {
    assert.equal(
      capability(field) & ~LAUNCHER_CAP_MASK,
      0n,
      `${field} carries an extra capability`
    );
  }
}

interface OwnerObservation {
  readonly uid: number;
  readonly gid: number;
  readonly Groups: string;
  readonly authUsable: boolean;
  readonly authUnchanged: boolean;
  readonly sourceUid: number;
  readonly sourceGid: number;
  readonly sourceMode: number;
  readonly CapPrm: string;
  readonly CapEff: string;
  readonly CapInh: string;
  readonly CapAmb: string;
}

function assertOwnerIdentity(status: OwnerObservation): void {
  assert.equal(status.uid, OWNER_UID);
  assert.equal(status.gid, OWNER_UID);
  assert.equal(status.Groups, "");
  for (const field of ["CapPrm", "CapEff", "CapInh", "CapAmb"] as const) {
    assert.equal(status[field], "0000000000000000", `${field} was not dropped`);
  }
}

function childSource(): string {
  return [
    "const fs = require('node:fs');",
    "const status = fs.readFileSync('/proc/self/status', 'utf8');",
    "const field = (name) => status.split('\\n').find((line) => line.startsWith(name + ':')).slice(name.length + 1).trim();",
    "const authPath = process.env.HOME + '/.codex/auth.json';",
    "const authText = fs.readFileSync(authPath, 'utf8');",
    "const auth = JSON.parse(authText);",
    "const sourceStat = fs.statSync(authPath);",
    "process.stdout.write(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), Groups: field('Groups'), authUsable: auth.tokens?.access_token === 'synthetic-access' && auth.tokens?.account_id === 'synthetic-account', authUnchanged: authText === '{\"tokens\":{\"access_token\":\"synthetic-access\",\"account_id\":\"synthetic-account\"}}', sourceUid: sourceStat.uid, sourceGid: sourceStat.gid, sourceMode: sourceStat.mode & 0o777, CapPrm: field('CapPrm'), CapEff: field('CapEff'), CapInh: field('CapInh'), CapAmb: field('CapAmb') }) + '\\n');"
  ].join(" ");
}

function runAs(uid: number, capabilities: string, mode: string, base: string) {
  return spawnSync(
    "setpriv",
    [
      `--reuid=${uid}`,
      `--regid=${uid}`,
      "--clear-groups",
      `--inh-caps=${capabilities}`,
      `--ambient-caps=${capabilities}`,
      "--",
      process.execPath,
      "--import",
      "tsx",
      SCRIPT,
      "--child",
      mode,
      base
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }
  );
}

function dataUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function unprotectedPreparationSource(): string {
  const source = readFileSync(
    join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs"),
    "utf8"
  );
  const start = source.indexOf("async function readSecretSource(file) {");
  const end = source.indexOf("\n}\n\nasync function writeSecretFile", start) + 2;
  assert(start >= 0 && end > start, "could not locate owner reader in preparation source");
  return `${source.slice(0, start)}async function readSecretSource(file) {
  const handle = await open(file.sourcePath, O_RDONLY);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}${source.slice(end)}`;
}

function runOwnerPreparationSource(base: string, source: string): ReturnType<typeof spawnSync> {
  const auth = join(base, "home", "agents", "user-symlink-file", ".codex", "auth.json");
  const request = JSON.stringify({
    dirs: [join(base, "home", "agents", "user-symlink-file", ".codex")],
    denyFile: null
  });
  const wrapper = `process.argv[2] = ${JSON.stringify(request)}; await import(${JSON.stringify(dataUrl(source))});`;
  return spawnSync(
    "setpriv",
    [
      `--reuid=${OWNER_UID}`,
      `--regid=${OWNER_UID}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      process.execPath,
      "--input-type=module",
      "--eval",
      wrapper
    ],
    {
      encoding: "utf8",
      input: JSON.stringify([{ path: auth, sourcePath: auth, kind: "codex-auth" }]),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }
    }
  );
}

async function negativeSymlinkChild(base: string): Promise<void> {
  const result = runOwnerPreparationSource(base, unprotectedPreparationSource());
  assert.notEqual(
    result.status,
    0,
    `foreign same-owner symlink was accepted by the mutated preparation: ${result.stdout}`
  );
}

async function negativeCrossUserChild(): Promise<void> {
  const prototype = LoginService.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const originalMatchFlow = prototype.matchFlow;
  assert(originalMatchFlow, "could not locate LoginService flow match guard");
  // In-memory mutation of the actual production class: remove only the caller
  // identity argument, leaving provider and login-id matching intact.
  prototype.matchFlow = function (provider, loginId) {
    return originalMatchFlow.call(this, provider, loginId, undefined);
  };
  const io = {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    sleep: async () => undefined,
    readFile: async () => "",
    writeFile: async () => undefined
  } as TmuxIo;
  const service = new LoginService({
    io,
    homeBase: tmpdir(),
    adapters: LOGIN_ADAPTERS,
    probe: async () => ({ status: "needs_login" as const }),
    settleMs: 0
  });
  const loginId = service.reserve("anthropic", "user-a");
  await service.start(loginId);
  let failures = 0;
  for (const operation of [
    () => service.poll("anthropic", loginId, "user-b"),
    () => service.submitToken("anthropic", loginId, "synthetic-token", "user-b")
  ]) {
    try {
      await assert.rejects(operation);
    } catch {
      failures += 1;
    }
  }
  await service.cancel("anthropic", loginId, "user-a");
  assert.equal(failures, 0, `mutated cross-user poll/submit accepted ${failures} assertion(s)`);
}

function runNegativeChild(mode: string, base: string): void {
  const result = runAs(LAUNCHER_UID, LAUNCHER_CAPS, mode, base);
  assert.notEqual(result.status, 0, `${mode} mutation unexpectedly passed its protected assertion`);
  assert(result.stderr.trim(), `${mode} mutation produced no failing assertion output`);
  console.log(`${mode} failed as expected: ${result.stderr.trim()}`);
}

function makeHost(base: string): AcpHost {
  const homeBase = join(base, "home");
  const neutralBase = join(base, "neutral");
  return new AcpHost({
    homeBase,
    neutralBase,
    perUserUid: true,
    allocateUidSlot: () => ({ uid: OWNER_UID, gid: OWNER_UID }),
    resolveAdapterTarget: () => ({ command: process.execPath, args: ["-e", childSource()] })
  });
}

async function spawnValid(host: AcpHost, sessionKey: string): Promise<void> {
  const result = await host.spawn(sessionKey, "project", "openai", "user-a", "workshop");
  assert.equal(result.uid, OWNER_UID);
  assert.equal(result.gid, OWNER_UID);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = host.read(sessionKey, 0);
    if (read.lines.length > 0) {
      const observed = JSON.parse(read.lines[0]!) as OwnerObservation;
      assertOwnerIdentity(observed);
      assert.equal(observed.authUsable, true);
      assert.equal(observed.authUnchanged, true);
      assert.equal(observed.sourceUid, OWNER_UID);
      assert.equal(observed.sourceGid, OWNER_UID);
      assert.equal(observed.sourceMode, 0o600);
      console.log(JSON.stringify(observed));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("owner ACP child produced no diagnostic line");
}

async function child(mode: string, base: string): Promise<void> {
  assertLauncherIdentity();
  if (mode === "--negative-symlink") {
    await negativeSymlinkChild(base);
    return;
  }
  if (mode === "--negative-cross-user") {
    await negativeCrossUserChild();
    return;
  }
  const host = makeHost(base);
  if (mode === "valid-1" || mode === "valid-2") {
    await spawnValid(host, `session-${mode}`);
    return;
  }
  if (mode === "missing") {
    await assert.rejects(
      host.spawn("missing-session", "project", "openai", "user-missing", "workshop")
    );
    return;
  }
  if (mode === "wrong-owner") {
    await assert.rejects(
      host.spawn("wrong-owner-session", "project", "openai", "user-wrong", "workshop")
    );
    return;
  }
  if (mode === "symlink-parent" || mode === "symlink-file" || mode === "inaccessible") {
    await assert.rejects(
      host.spawn(`failure-${mode}`, "project", "openai", `user-${mode}`, "workshop")
    );
    return;
  }
  throw new Error(`unknown diagnostic child mode: ${mode}`);
}

function prepareBase(): { base: string } {
  const base = mkdtempSync(join(tmpdir(), "codex-login-isolation-"));
  const homeBase = join(base, "home");
  const agents = join(homeBase, "agents");
  const owner = join(agents, "user-a");
  const codex = join(owner, ".codex");
  const auth = join(codex, "auth.json");
  for (const path of [base, homeBase, agents]) mkdirSync(path, { mode: 0o711, recursive: true });
  mkdirSync(codex, { recursive: true, mode: 0o700 });
  writeFileSync(auth, SYNTHETIC_AUTH, { mode: 0o600 });
  chownSync(auth, OWNER_UID, OWNER_UID);
  chownSync(codex, OWNER_UID, OWNER_UID);
  chownSync(owner, OWNER_UID, OWNER_UID);
  const neutral = join(base, "neutral");
  mkdirSync(neutral, { mode: 0o711 });
  return { base };
}

function addMissingFixtures(base: string): void {
  const homeBase = join(base, "home");
  const sharedCodex = join(homeBase, ".codex");
  mkdirSync(sharedCodex, { mode: 0o711 });
  writeFileSync(join(sharedCodex, "auth.json"), "shared-secret-must-not-be-used", {
    mode: 0o644
  });

  const missing = join(homeBase, "agents", "user-missing");
  mkdirSync(missing, { mode: 0o700 });
  chownSync(missing, OWNER_UID, OWNER_UID);

  const wrong = join(homeBase, "agents", "user-wrong");
  mkdirSync(wrong, { mode: 0o700 });
  chownSync(wrong, OTHER_UID, OTHER_UID);

  const victim = join(base, "victim");
  mkdirSync(victim, { mode: 0o755 });
  writeFileSync(join(victim, "canary"), "untouched", { mode: 0o644 });
  symlinkSync(victim, join(homeBase, "agents", "user-symlink-parent"));

  const symlinkFileOwner = join(homeBase, "agents", "user-symlink-file");
  const symlinkFileCodex = join(symlinkFileOwner, ".codex");
  mkdirSync(symlinkFileCodex, { recursive: true, mode: 0o700 });
  const linked = join(victim, "linked-auth.json");
  writeFileSync(linked, SYNTHETIC_AUTH, { mode: 0o644 });
  chownSync(linked, OWNER_UID, OWNER_UID);
  symlinkSync(linked, join(symlinkFileCodex, "auth.json"));
  chownSync(symlinkFileCodex, OWNER_UID, OWNER_UID);
  chownSync(symlinkFileOwner, OWNER_UID, OWNER_UID);

  const inaccessibleOwner = join(homeBase, "agents", "user-inaccessible");
  const inaccessibleCodex = join(inaccessibleOwner, ".codex");
  const inaccessibleAuth = join(inaccessibleCodex, "auth.json");
  mkdirSync(inaccessibleCodex, { recursive: true, mode: 0o700 });
  writeFileSync(inaccessibleAuth, SYNTHETIC_AUTH, { mode: 0o000 });
  chownSync(inaccessibleAuth, OWNER_UID, OWNER_UID);
  chownSync(inaccessibleCodex, OWNER_UID, OWNER_UID);
  chownSync(inaccessibleOwner, OWNER_UID, OWNER_UID);
}

function runChild(mode: string, base: string): void {
  const result = runAs(LAUNCHER_UID, LAUNCHER_CAPS, mode, base);
  if (result.status !== 0) {
    throw new Error(
      `diagnostic child ${mode} failed (status=${String(result.status)}): ${result.stderr.trim()}`
    );
  }
}

async function main(): Promise<void> {
  requireDisposableRoot();
  const fixture = prepareBase();
  try {
    addMissingFixtures(fixture.base);
    for (const sharedPath of [
      join(fixture.base, "home"),
      join(fixture.base, "home", "agents"),
      join(fixture.base, "home", ".codex"),
      join(fixture.base, "neutral")
    ]) {
      chownSync(sharedPath, LAUNCHER_UID, LAUNCHER_UID);
      chmodSync(sharedPath, 0o711);
    }
    chmodSync(fixture.base, 0o711);
    if (process.argv[2] === "--negative-cross-user" || process.argv[2] === "--negative-symlink") {
      runNegativeChild(process.argv[2], fixture.base);
      return;
    }
    runChild("valid-1", fixture.base);
    runChild("valid-2", fixture.base);

    runChild("missing", fixture.base);
    assert.equal(
      readFileSync(join(fixture.base, "home", ".codex", "auth.json"), "utf8"),
      "shared-secret-must-not-be-used"
    );
    runChild("wrong-owner", fixture.base);
    assert.equal(statSync(join(fixture.base, "home", "agents", "user-wrong")).uid, OTHER_UID);
    runChild("symlink-parent", fixture.base);
    assert.equal(readFileSync(join(fixture.base, "victim", "canary"), "utf8"), "untouched");
    runChild("symlink-file", fixture.base);
    assert.equal(
      readFileSync(join(fixture.base, "victim", "linked-auth.json"), "utf8"),
      SYNTHETIC_AUTH
    );
    runChild("inaccessible", fixture.base);
    console.log(
      "Codex login isolation diagnostic passed: owner preparation, reuse, and refusal cases."
    );
  } finally {
    // The required container deliberately omits DAC_OVERRIDE. Owner-only fixture
    // folders are disposable with the container, so cleanup must not mask the
    // assertions when the root harness cannot traverse them.
    try {
      rmSync(fixture.base, { recursive: true, force: true });
    } catch {
      // The container is --rm; any unreachable fixture state dies with it.
    }
  }
}

if (process.argv[2] === "--child") {
  await child(process.argv[3]!, process.argv[4]!);
} else {
  await main();
}
