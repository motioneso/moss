import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, chownSync, mkdirSync } from "node:fs";

import { resolveMossEnv } from "@moss/db";

export type ChildRole = "api" | "worker" | "cli-runner";

export interface ProcessSpec {
  readonly role: ChildRole;
  readonly command: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

interface OneShotSpec {
  readonly command: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly uid: number;
  readonly gid: number;
}

export interface StartupPlan {
  readonly uid: number;
  readonly gid: number;
  /** Run sequentially, in order, before any resident process starts (#964). */
  readonly oneShots: readonly OneShotSpec[];
  readonly resident: readonly ProcessSpec[];
}

const CLI_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "NPM_CONFIG_PREFIX",
  "JARVIS_CLI_TOOLS_PREFIX",
  "JARVIS_CLI_HOME",
  "JARVIS_CLI_HOME_BASE",
  "JARVIS_CLI_NEUTRAL_BASE",
  "JARVIS_HOST_UID",
  "JARVIS_HOST_GID",
  "TERM",
  "LANG",
  "TMPDIR",
  "DISABLE_AUTOUPDATER",
  "JARVIS_CLI_PER_USER_UID",
  "JARVIS_CLI_RUNNER_RPC_SECRET",
  "JARVIS_CLI_RUNNER_SINGLE_USER",
  "JARVIS_CLI_RUNNER_SOCKET",
  "JARVIS_MCP_SERVER_URL",
  "JARVIS_MULTIPLEXER",
  // #1467: the cli-runner builds the live permission-hook command line for every containerized
  // deploy (resolveVaultRoots() -> vaultRootsEnvEntry() in claude-permission-hook.ts) and needs
  // the app-validated vault roots to do it; without these, that fix is inert in this topology.
  "JARVIS_NOTES_ROOTS",
  "MOSS_NOTES_ROOTS"
]);

// The one folder tests/uat/provisioner.ts ever writes into JARVIS_UAT_SCRIPTED_PROVIDER_BIN. See
// buildChildEnv below for why this is a value pin rather than a mode flag.
const UAT_SCRIPTED_PROVIDER_BIN = "/app/tests/uat/fixtures/scripted-provider/bin";

const CLI_ENV_PREFIXES = ["LC_"];

export function runtimeUidGid(env: NodeJS.ProcessEnv = process.env): { uid: number; gid: number } {
  const uid = Number(env.JARVIS_HOST_UID ?? 1000);
  const gid = Number(env.JARVIS_HOST_GID ?? 1000);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error("JARVIS_HOST_UID must be a positive integer");
  }
  if (!Number.isInteger(gid) || gid <= 0) {
    throw new Error("JARVIS_HOST_GID must be a positive integer");
  }
  return { uid, gid };
}

export function buildChildEnv(
  role: ChildRole,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (role !== "cli-runner") {
    return {
      ...env,
      PORT: env.PORT ?? "3000",
      HOST: env.HOST ?? "0.0.0.0",
      HF_HOME: env.HF_HOME ?? "/app/.cache/huggingface",
      JARVIS_CLI_RUNNER_SOCKET: env.JARVIS_CLI_RUNNER_SOCKET ?? "/run/jarv1s/cli-runner.sock",
      JARVIS_MCP_SERVER_URL: env.JARVIS_MCP_SERVER_URL ?? "http://127.0.0.1:3000/api/mcp"
    };
  }

  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CLI_ENV_KEYS.has(key) || CLI_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      next[key] = value;
    }
  }

  next.JARVIS_CLI_TOOLS_PREFIX = env.JARVIS_CLI_TOOLS_PREFIX ?? "/data/cli-tools";
  next.PATH = `${next.JARVIS_CLI_TOOLS_PREFIX}/bin:${env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  next.HOME = resolveMossEnv(env, "JARVIS_CLI_HOME") ?? "/data/cli-auth";
  next.JARVIS_CLI_HOME = next.HOME;
  next.JARVIS_CLI_HOME_BASE = resolveMossEnv(env, "JARVIS_CLI_HOME_BASE") ?? next.HOME;
  next.JARVIS_CLI_NEUTRAL_BASE =
    resolveMossEnv(env, "JARVIS_CLI_NEUTRAL_BASE") ?? "/data/cli-auth/chat";
  next.NPM_CONFIG_PREFIX = env.NPM_CONFIG_PREFIX ?? next.JARVIS_CLI_TOOLS_PREFIX;
  next.JARVIS_CLI_RUNNER_SOCKET = env.JARVIS_CLI_RUNNER_SOCKET ?? "/run/jarv1s/cli-runner.sock";
  next.JARVIS_CLI_RUNNER_RPC_SECRET = env.JARVIS_CLI_RUNNER_RPC_SECRET;
  next.JARVIS_CLI_RUNNER_SINGLE_USER = env.JARVIS_CLI_RUNNER_SINGLE_USER ?? "0";
  next.JARVIS_CLI_PER_USER_UID = env.JARVIS_CLI_PER_USER_UID ?? "0";
  next.JARVIS_MULTIPLEXER = resolveMossEnv(env, "JARVIS_MULTIPLEXER") ?? "tmux";
  next.JARVIS_MCP_SERVER_URL = env.JARVIS_MCP_SERVER_URL ?? "http://127.0.0.1:3000/api/mcp";

  // JARVIS_UAT_SEED_CHAT_SCRIPT / JARVIS_UAT_SCRIPTED_PROVIDER_BIN select and PATH-inject a fake
  // "claude" CLI binary for the UAT live-test fixture. JARVIS_UAT_SCRIPTED_PROVIDER_BIN in
  // particular names a folder the Dockerfile puts first on the login-shell PATH used to launch
  // the real AI provider CLI — the same image runs in production, so a mode flag is not enough
  // (it would travel into a production container by the same conduit as the setting itself, and
  // authorize nothing an attacker couldn't already set). Instead, only the one fixed value the
  // UAT fixture ever needs is honored; anything else is dropped. This pin applies to the
  // cli-runner child role built here only — the worker and api roles above receive the full app
  // env by design, with the worker's own module-build subprocess tree protected separately at
  // its own composition root (apps/worker/src/worker.ts's createModuleBuildIo).
  if (env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN === UAT_SCRIPTED_PROVIDER_BIN) {
    next.JARVIS_UAT_SCRIPTED_PROVIDER_BIN = UAT_SCRIPTED_PROVIDER_BIN;
    if (env.JARVIS_UAT_SEED_CHAT_SCRIPT !== undefined) {
      next.JARVIS_UAT_SEED_CHAT_SCRIPT = env.JARVIS_UAT_SEED_CHAT_SCRIPT;
    }
  }

  return next;
}

export function buildStartupPlan(env: NodeJS.ProcessEnv = process.env): StartupPlan {
  const { uid, gid } = runtimeUidGid(env);
  const oneShotEnv = { ...env, NODE_ENV: env.NODE_ENV ?? "production" };
  const oneShots: OneShotSpec[] = [
    { command: ["node_modules/.bin/tsx", "scripts/migrate.ts"], env: oneShotEnv, uid, gid },
    // #996/#860: reconcile modules AFTER core migrations (module installs depend on the
    // platform tables existing) and BEFORE the api/worker boot (they must see the
    // post-reconcile module set). Always runs now — external modules are always-on.
    { command: ["node_modules/.bin/tsx", "scripts/module-reconcile.ts"], env: oneShotEnv, uid, gid }
  ];
  return {
    uid,
    gid,
    oneShots,
    resident: [
      {
        role: "cli-runner",
        command: ["node_modules/.bin/tsx", "packages/cli-runner/src/main-entry.ts"],
        env: buildChildEnv("cli-runner", env)
      },
      { role: "worker", command: ["node", "dist/worker.js"], env: buildChildEnv("worker", env) },
      { role: "api", command: ["node", "dist/server.js"], env: buildChildEnv("api", env) }
    ]
  };
}

export function prepareRuntimeDirs(uid: number, gid: number): void {
  for (const dir of [
    "/data/cli-tools",
    "/data/cli-auth",
    "/data/vaults",
    "/data/modules",
    "/app/.cache/huggingface",
    "/run/jarv1s"
  ]) {
    mkdirSync(dir, { recursive: true });
    chownSync(dir, uid, gid);
  }
  chmodSync("/run/jarv1s", 0o700);
}

async function runOneShot(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  uid: number,
  gid: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { env, gid, stdio: "inherit", uid });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command.join(" ")} exited with ${code ?? "unknown"}`));
    });
    child.once("error", reject);
  });
}

function spawnResident(spec: ProcessSpec, uid: number, gid: number): ChildProcess {
  const [cmd, ...args] = spec.command;
  return spawn(cmd!, args, {
    env: spec.env,
    gid,
    stdio: "inherit",
    uid
  });
}

async function main(): Promise<void> {
  const plan = buildStartupPlan();
  prepareRuntimeDirs(plan.uid, plan.gid);
  for (const oneShot of plan.oneShots) {
    await runOneShot(oneShot.command, oneShot.env, oneShot.uid, oneShot.gid);
  }

  const children: { spec: ProcessSpec; child: ChildProcess }[] = [];
  let shuttingDown = false;

  const waitForChildren = async (): Promise<void> => {
    await Promise.race([
      Promise.allSettled(children.map(({ child }) => once(child, "exit"))),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000))
    ]);
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    shuttingDown = true;
    for (const { child } of children) child.kill(signal);
    await waitForChildren();
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));

  for (const spec of plan.resident) {
    const child = spawnResident(spec, plan.uid, plan.gid);
    children.push({ spec, child });
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`[jarv1s] ${spec.role} exited`, { code, signal });
      void shutdown("SIGTERM").then(() => process.exit(code ?? 1));
    });
  }
}

if (process.argv[1]?.endsWith("start-jarv1s.ts")) {
  await main();
}
