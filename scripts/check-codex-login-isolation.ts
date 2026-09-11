import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
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
import { CliChatEngineHost } from "../packages/cli-runner/src/engine-host.js";
import { createCliRunner, resolveIsolatedUserRuntime } from "../packages/cli-runner/src/main.js";
import { LOGIN_ADAPTERS } from "../packages/cli-runner/src/login-adapters.js";
import { LoginService } from "../packages/cli-runner/src/login-service.js";
import type { LoginUserRuntime } from "../packages/cli-runner/src/login-service.js";
import { ensureGeminiOnboarded } from "../packages/cli-runner/src/provider-first-run.js";
import {
  providerTokenPath,
  readProviderCredentialEnv
} from "../packages/cli-runner/src/provider-token-store.js";
import {
  clearProviderProbeCacheForTests,
  probeProvider,
  recordProviderLoginRejected
} from "../packages/chat/src/live/provider-probe.js";
import type { ProbeProviderResult } from "../packages/chat/src/live/provider-probe.js";
import type { RpcProviderKind } from "../packages/chat/src/live/rpc-contract.js";
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

const ownerIdentitySource = [
  "const fs = require('node:fs');",
  "const status = fs.readFileSync('/proc/self/status', 'utf8');",
  "const field = (name) => status.split('\\n').find((line) => line.startsWith(name + ':')).slice(name.length + 1).trim();",
  "process.stdout.write(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), home: process.env.HOME, Groups: field('Groups'), CapPrm: field('CapPrm'), CapEff: field('CapEff'), CapInh: field('CapInh'), CapAmb: field('CapAmb') }));"
].join(" ");

async function task2Child(base: string): Promise<void> {
  const homeBase = join(base, "home");
  const userA = await resolveIsolatedUserRuntime({ perUserUid: true, homeBase }, "user-a");
  const userB = await resolveIsolatedUserRuntime({ perUserUid: true, homeBase }, "user-b");
  const identity = await userA.io.run(process.execPath, ["-e", ownerIdentitySource]);
  assert.equal(identity.code, 0, identity.stderr);
  const observed = JSON.parse(identity.stdout) as Record<string, string | number>;
  assert.equal(observed.uid, OWNER_UID);
  assert.equal(observed.gid, OWNER_UID);
  assert.equal(observed.home, userA.homeBase);
  assert.equal(observed.Groups, "");
  for (const field of ["CapPrm", "CapEff", "CapInh", "CapAmb"])
    assert.equal(observed[field], "0000000000000000", `${field} was not dropped`);

  clearProviderProbeCacheForTests();
  const ready = await probeProvider("openai-compatible", {
    io: userA.io,
    cliPresent: async () => true,
    cacheScope: "user-a"
  });
  assert.equal(ready.status, "ready");
  const needsLogin = await probeProvider("openai-compatible", {
    io: userB.io,
    cliPresent: async () => true,
    cacheScope: "user-b"
  });
  assert.equal(needsLogin.status, "needs_login");

  const vendor = (status: number) => async (): Promise<Response> => {
    if (status === 0) throw new Error("synthetic network failure");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ models: [] })
    } as Response;
  };
  // Reach the callback composed by createCliRunner itself. The diagnostic deliberately exercises
  // that production closure, rather than rebuilding a lookalike probe with test-only deps.
  const runner = createCliRunner({
    socketPath: join(base, "runner", "sock"),
    rpcSecret: "synthetic-rpc-secret",
    singleUser: true,
    perUserUid: true,
    neutralBase: join(base, "neutral"),
    homeBase: join(base, "home"),
    toolsPrefix: join(base, "tools"),
    persistentRuntimeEnabled: false,
    persistentPoolCap: 4,
    persistentIdleReapMinutes: 30
  });
  const runnerDeps = (
    runner as unknown as {
      deps: { host: CliChatEngineHost };
    }
  ).deps;
  const hostDeps = (
    runnerDeps.host as unknown as {
      deps: { loginService: LoginService };
    }
  ).deps;
  const loginDeps = (
    hostDeps.loginService as unknown as {
      deps: {
        probe: (
          provider: "openai-compatible",
          opts?: { readonly forceFresh?: boolean; readonly runtime?: LoginUserRuntime }
        ) => Promise<ProbeProviderResult>;
      };
    }
  ).deps;
  const productionProbe = loginDeps.probe;
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 0, 503]) {
      clearProviderProbeCacheForTests();
      recordProviderLoginRejected("openai-compatible", undefined, "user-a");
      globalThis.fetch = vendor(status);
      const result = await productionProbe("openai-compatible", {
        forceFresh: true,
        runtime: userA
      });
      assert.equal(result.status, "needs_login", `main verification status=${status}`);
      // A normal follow-up must still honor the refusal; it cannot clear the cache by observing
      // the local Codex auth file alone. This runs before the cache is reset for the next case.
      globalThis.fetch = vendor(200);
      const cached = await productionProbe("openai-compatible", { runtime: userA });
      assert.equal(cached.status, "needs_login", `cached refusal status=${status}`);
    }
    clearProviderProbeCacheForTests();
    recordProviderLoginRejected("openai-compatible", undefined, "user-a");
    globalThis.fetch = vendor(200);
    assert.equal(
      (await productionProbe("openai-compatible", { forceFresh: true, runtime: userA })).status,
      "ready"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const launcherIo: TmuxIo = {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    sleep: async () => undefined,
    readFile: async () => "",
    writeFile: async () => undefined
  };
  let hostFetch: typeof globalThis.fetch = vendor(200);
  const host = new CliChatEngineHost({
    io: launcherIo,
    neutralBase: join(base, "neutral"),
    homeBase: join(base, "home"),
    singleUser: true,
    perUserUid: true,
    cliPresent: async () => true,
    fetch: (...args) => hostFetch(...args),
    resolveUserRuntime: async (userId) =>
      userId === "user-a"
        ? userA
        : await resolveIsolatedUserRuntime({ perUserUid: true, homeBase }, userId)
  });
  for (const status of [401, 0, 503, 200]) {
    clearProviderProbeCacheForTests();
    recordProviderLoginRejected("openai-compatible", undefined, "user-a");
    hostFetch = vendor(status);
    const result = await host.probeProvider("openai-compatible", "user-a", {
      forceFresh: true
    });
    assert.equal(
      result.status,
      status === 200 ? "ready" : "needs_login",
      `engine verification status=${status}`
    );
  }

  const fifoUser = await resolveIsolatedUserRuntime({ perUserUid: true, homeBase }, "user-fifo");
  const fifoSetup = await fifoUser.io.run(process.execPath, [
    "-e",
    "const fs=require('node:fs'); const cp=require('node:child_process'); const path=require('node:path'); const dir=path.join(process.env.HOME,'.codex'); fs.mkdirSync(dir,{mode:0o700}); const auth=path.join(dir,'auth.json'); cp.execFileSync('mkfifo',[auth]); fs.chmodSync(auth,0o600);"
  ]);
  assert.equal(fifoSetup.code, 0, fifoSetup.stderr);
  clearProviderProbeCacheForTests();
  recordProviderLoginRejected("openai-compatible", undefined, "user-fifo");
  let fifoReads = 0;
  const fifoRuntime: LoginUserRuntime = {
    ...fifoUser,
    readCodexAuthFile: async (path) => {
      fifoReads += 1;
      return fifoUser.readCodexAuthFile!(path);
    }
  };
  globalThis.fetch = vendor(200);
  const fifoService = new LoginService({
    io: launcherIo,
    homeBase,
    adapters: LOGIN_ADAPTERS,
    resolveUserRuntime: async () => fifoRuntime,
    probe: (provider, opts) => {
      assert.equal(provider, "openai-compatible");
      return productionProbe(provider, opts);
    },
    settleMs: 0,
    surfaceTimeoutMs: 200
  });
  const fifoLogin = fifoService.reserve("openai-compatible", "user-fifo");
  const fifoStart = fifoService.start(fifoLogin);
  const fifoOutcome = await Promise.race([
    fifoStart,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO reader hung")), 1500))
  ]);
  assert.equal(fifoOutcome.status, "awaiting_authorization");
  assert.equal(fifoReads, 1, "FIFO verification reader was not called exactly once");
  await fifoService.cancel("openai-compatible", fifoLogin, "user-fifo");
  console.log(
    "Task 2 owner runtime, account scope, callback regressions, and FIFO diagnostic passed."
  );
}

interface LoginIoState {
  pane: string;
  readonly calls: { command: string; args: string[] }[];
  readonly live: Set<string>;
  failPaste: boolean;
}

function loginIo(state: LoginIoState): TmuxIo {
  return {
    run: async (command, args) => {
      state.calls.push({ command, args: [...args] });
      if (command !== "tmux") return { code: 0, stdout: "", stderr: "" };
      const verb = args[0] === "-S" ? args[2] : args[0];
      if (verb === "new-session") {
        state.live.add(args[args.indexOf("-s") + 1]!);
      } else if (verb === "kill-session") {
        state.live.delete(args[args.indexOf("-t") + 1]!.replace(/^=/, ""));
      } else if (verb === "capture-pane") {
        return { code: 0, stdout: state.pane, stderr: "" };
      } else if (verb === "send-keys" && state.failPaste) {
        const pasted = state.calls.some(({ args: callArgs }) => callArgs.includes("paste-buffer"));
        if (pasted) throw new Error("synthetic paste failure");
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    sleep: async () => undefined,
    readFile: async () => "",
    writeFile: async () => undefined
  };
}

function absent(path: string): void {
  assert.equal(existsSync(path), false, `unexpected path exists: ${path}`);
}

async function assertAbsentAsOwner(runtime: LoginUserRuntime, path: string): Promise<void> {
  const result = await runtime.io.run(process.execPath, [
    "-e",
    "const fs=require('node:fs'); process.exit(fs.existsSync(process.argv[1]) ? 1 : 0);",
    path
  ]);
  assert.equal(result.code, 0, result.stderr);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

async function task3Child(base: string): Promise<void> {
  assert.equal(process.getuid?.(), LAUNCHER_UID);
  assert.equal(process.getgid?.(), LAUNCHER_UID);

  const sharedHome = join(base, "home");
  const googleHome = join(sharedHome, "google-shared-home");
  mkdirSync(googleHome, { mode: 0o733 });
  chownSync(googleHome, LAUNCHER_UID, LAUNCHER_UID);
  const ownerRuntimes = new Map<string, LoginUserRuntime>();
  for (const userId of ["user-anthropic", "user-google"]) {
    ownerRuntimes.set(
      userId,
      await resolveIsolatedUserRuntime({ perUserUid: true, homeBase: sharedHome }, userId)
    );
  }
  const resolverCalls: string[] = [];
  const observedProbeHomes: string[] = [];
  const resolveOwnerRuntime = async (
    provider: RpcProviderKind,
    userId: string
  ): Promise<LoginUserRuntime> => {
    resolverCalls.push(`${provider}:${userId}`);
    const runtime = ownerRuntimes.get(userId);
    assert(runtime, `missing competing owner runtime for ${userId}`);
    return runtime;
  };
  const sharedProbe = async (
    provider: RpcProviderKind,
    opts?: { readonly runtime?: LoginUserRuntime }
  ) => {
    observedProbeHomes.push(`${provider}:${opts?.runtime?.homeBase ?? ""}`);
    return { status: "needs_login" as const };
  };
  const anthropicOwner = ownerRuntimes.get("user-anthropic")!;
  const googleOwner = ownerRuntimes.get("user-google")!;
  assert.notEqual(anthropicOwner.homeBase, sharedHome);
  assert.notEqual(googleOwner.homeBase, sharedHome);
  const token = "sk-ant-oat-synthetic-task3-token-0123456789abcdefghij";
  const successState: LoginIoState = {
    pane: "https://claude.com/cai/oauth/authorize?code=synthetic",
    calls: [],
    live: new Set(),
    failPaste: false
  };
  const successService = new LoginService({
    io: loginIo(successState),
    homeBase: sharedHome,
    adapters: LOGIN_ADAPTERS,
    resolveUserRuntime: resolveOwnerRuntime,
    probe: sharedProbe,
    settleMs: 0,
    surfaceTimeoutMs: 200
  });
  const successLogin = successService.reserve("anthropic", "user-anthropic");
  const started = await successService.start(successLogin);
  assert.equal(started.status, "awaiting_token");
  successState.pane = `Long-lived authentication token created\n${token}`;
  const successOutcome = await successService.submitToken(
    "anthropic",
    successLogin,
    "synthetic-paste-code",
    "user-anthropic"
  );
  assert.equal(successOutcome.status, "awaiting_token");

  const tokenPath = providerTokenPath(sharedHome, "anthropic");
  assert.equal(readFileSync(tokenPath, "utf8"), token);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  const credentialEnv = await readProviderCredentialEnv(sharedHome, "anthropic");
  assert.equal(credentialEnv.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert(
    successState.calls.some(
      ({ command, args }) => command === "tmux" && args.includes("delete-buffer")
    ),
    "successful paste did not delete its tmux buffer"
  );
  const successPaste = successState.calls.find(
    ({ command, args }) => command === "tmux" && args.includes("load-buffer")
  );
  assert(successPaste, "successful paste did not load a token file");
  absent(successPaste.args.at(-1)!);
  await assertAbsentAsOwner(
    anthropicOwner,
    join(anthropicOwner.homeBase, ".jarvis", "cli-tokens", "anthropic")
  );
  await successService.cancel("anthropic", successLogin, "user-anthropic");

  rmSync(tokenPath, { force: true });
  const failureState: LoginIoState = {
    pane: "https://claude.com/cai/oauth/authorize?code=synthetic-failure",
    calls: [],
    live: new Set(),
    failPaste: true
  };
  const failureService = new LoginService({
    io: loginIo(failureState),
    homeBase: sharedHome,
    adapters: LOGIN_ADAPTERS,
    resolveUserRuntime: resolveOwnerRuntime,
    probe: sharedProbe,
    settleMs: 0,
    surfaceTimeoutMs: 200
  });
  const failureLogin = failureService.reserve("anthropic", "user-anthropic");
  await failureService.start(failureLogin);
  const failureOutcome = await failureService.submitToken(
    "anthropic",
    failureLogin,
    "synthetic-failure-code",
    "user-anthropic"
  );
  assert.equal(failureOutcome.status, "error");
  const failurePaste = failureState.calls.find(
    ({ command, args }) => command === "tmux" && args.includes("load-buffer")
  );
  assert(failurePaste, "failed paste did not load a token file");
  await waitFor(
    () => failureState.calls.some(({ args }) => args.includes("delete-buffer")),
    "failed paste cleanup did not delete its tmux buffer"
  );
  absent(failurePaste.args.at(-1)!);
  absent(tokenPath);
  await assertAbsentAsOwner(
    anthropicOwner,
    join(anthropicOwner.homeBase, ".jarvis", "cli-tokens", "anthropic")
  );
  await failureService.cancel("anthropic", failureLogin, "user-anthropic");

  const googleState: LoginIoState = {
    pane: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic",
    calls: [],
    live: new Set(),
    failPaste: false
  };
  let preparedHome: string | undefined;
  const googleService = new LoginService({
    io: loginIo(googleState),
    homeBase: googleHome,
    adapters: LOGIN_ADAPTERS,
    resolveUserRuntime: resolveOwnerRuntime,
    probe: sharedProbe,
    prepareProvider: async (provider, runtime) => {
      assert.equal(provider, "google");
      preparedHome = runtime.homeBase;
      await ensureGeminiOnboarded(runtime.homeBase);
    },
    settleMs: 0,
    surfaceTimeoutMs: 200
  });
  const googleLogin = googleService.reserve("google", "user-google");
  const googleOutcome = await googleService.start(googleLogin);
  assert.equal(googleOutcome.status, "awaiting_token");
  assert.equal(preparedHome, googleHome);
  const googleSettings = JSON.parse(
    readFileSync(join(googleHome, ".gemini", "settings.json"), "utf8")
  ) as { security?: { auth?: { selectedType?: string } } };
  assert.equal(googleSettings.security?.auth?.selectedType, "oauth-personal");
  await assertAbsentAsOwner(googleOwner, join(googleOwner.homeBase, ".gemini", "settings.json"));
  await googleService.cancel("google", googleLogin, "user-google");

  assert.deepEqual(resolverCalls, [], "non-Codex login selected an owner runtime");
  assert.deepEqual(observedProbeHomes, [
    `anthropic:${sharedHome}`,
    `anthropic:${sharedHome}`,
    `anthropic:${sharedHome}`,
    `google:${googleHome}`
  ]);

  console.log(
    "Task 3 shared Anthropic/Google login runtime, token persistence, cleanup, and Codex isolation diagnostic passed."
  );
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
  if (mode === "task-2") {
    await task2Child(base);
    return;
  }
  if (mode === "task-3") {
    await task3Child(base);
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
  const bin = join(base, "bin");
  mkdirSync(bin, { mode: 0o755 });
  writeFileSync(
    join(bin, "codex"),
    "#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.139.0\\n'); process.exit(0); }\nconst auth = process.env.HOME + '/.codex/auth.json';\nif (!fs.existsSync(auth)) { process.stderr.write('not logged in'); process.exit(1); }\nprocess.stdout.write('Logged in using ChatGPT\\n');\n",
    { mode: 0o755 }
  );
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
  if ((mode === "task-2" || mode === "task-3") && result.stdout.trim()) {
    console.log(result.stdout.trim());
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
    chmodSync(join(fixture.base, "home"), 0o733);
    chmodSync(fixture.base, 0o711);
    const oldPath = process.env.PATH;
    process.env.PATH = `${join(fixture.base, "bin")}:${oldPath ?? "/usr/bin:/bin"}`;
    if (process.argv[2] === "--negative-cross-user" || process.argv[2] === "--negative-symlink") {
      runNegativeChild(process.argv[2], fixture.base);
      return;
    }
    runChild("task-2", fixture.base);
    runChild("task-3", fixture.base);
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
