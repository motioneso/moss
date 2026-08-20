/**
 * dev-instance cli-runner probe and bounded start (#1258, Phase 3).
 *
 * The chat path talks to the cli-runner over a unix socket that must live under `/run/jarv1s`
 * (`SOCKET_ALLOWED_DIR`, `packages/chat/src/live/chat-engine-rpc-client.ts:78`, realpath-enforced
 * with no env override). `/run` is a tmpfs, so that directory needs a one-time root setup —
 * `RUN_DIR_REPAIR_COMMAND` below. This module deliberately does NOT create it: writing under
 * `/run` and installing system config needs root, and a dev helper silently taking root is a
 * decision an operator should make, not a convenience. Instead the probe names the missing
 * directory and the exact command, so a fresh machine gets an instruction rather than a
 * mystery connection failure.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

import { RpcConnection } from "@moss/chat/live";

import { buildChildEnv } from "../start-jarv1s.js";
import type { DevInstanceConfig } from "./config.js";
import type { CliRunnerStatus } from "./provision.js";

/** The one-time root setup for the socket directory, quoted verbatim by doctor and by `fix`. */
export const RUN_DIR_REPAIR_COMMAND =
  'printf \'d /run/jarv1s 0770 %s %s -\\n\' "$(id -un)" "$(id -gn)" | sudo tee /etc/tmpfiles.d/jarv1s.conf && sudo systemd-tmpfiles --create';

/** How long a single probe waits for connect + handshake before calling the runner unreachable. */
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/** Bounded retry budget after a spawn. Never an unbounded wait (box-wide rule). */
const START_PROBE_ATTEMPTS = 10;
const START_PROBE_INTERVAL_MS = 500;

/** The subset of `RpcConnection` a probe needs, so tests can stand in a fake. */
export interface ProbeConnection {
  ensureConnected(): Promise<void>;
  close(): void;
}

export interface ProbeCliRunnerOptions {
  readonly timeoutMs?: number;
  readonly connect?: (socketPath: string, rpcSecret: string) => ProbeConnection;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Liveness check for the cli-runner: connect and complete the mutual hello, nothing more (there is
 * no ping verb in the RPC contract). Reports; never throws.
 *
 * The deadline is not optional politeness. `RpcConnection.ensureConnected()` retries
 * `ECONNREFUSED`/`ENOENT` with backoff *forever* (`chat-engine-rpc-client.ts:521-535`), which is
 * right for the chat path and fatal for a checkup — without the race below, a checkup against a
 * stopped runner never returns.
 */
export async function probeCliRunner(
  socketPath: string,
  rpcSecret: string | undefined,
  options: ProbeCliRunnerOptions = {}
): Promise<CliRunnerStatus> {
  const socketDir = dirname(socketPath);
  if (!(await directoryExists(socketDir))) {
    return {
      detail: `the socket directory ${socketDir} does not exist, so no cli-runner can be reached — one-time setup: ${RUN_DIR_REPAIR_COMMAND}`,
      reachable: false,
      socketPath
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const connection = options.connect
    ? options.connect(socketPath, rpcSecret ?? "")
    : new RpcConnection({ rpcSecret: rpcSecret ?? "", socketPath });

  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = Symbol("probe-timeout");
    const deadline = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    });

    const result = await Promise.race([
      connection.ensureConnected().then(() => "connected" as const),
      deadline
    ]);

    if (result === timedOut) {
      return {
        detail: `cli-runner did not answer at ${socketPath} within ${timeoutMs}ms`,
        reachable: false,
        socketPath
      };
    }
    return { detail: `cli-runner reachable at ${socketPath}`, reachable: true, socketPath };
  } catch (error) {
    return {
      detail: `cli-runner not reachable at ${socketPath}: ${(error as Error).message}`,
      reachable: false,
      socketPath
    };
  } finally {
    if (timer) clearTimeout(timer);
    connection.close();
  }
}

export interface EnsureCliRunnerDeps {
  readonly probe: (socketPath: string, rpcSecret: string | undefined) => Promise<CliRunnerStatus>;
  readonly spawnRunner: (config: DevInstanceConfig, env: NodeJS.ProcessEnv) => void;
  readonly delay: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the cli-runner the way prod does — `tsx packages/cli-runner/src/main-entry.ts` with the
 * env `buildChildEnv("cli-runner", …)` produces — but detached, from source, with dev's own HOME
 * base rather than the container's `/data` paths.
 */
function spawnDevCliRunner(config: DevInstanceConfig, env: NodeJS.ProcessEnv): void {
  const childEnv = buildChildEnv("cli-runner", {
    ...env,
    JARVIS_CLI_HOME: env.JARVIS_CLI_HOME ?? config.cliHomeBase,
    JARVIS_CLI_HOME_BASE: env.JARVIS_CLI_HOME_BASE ?? config.cliHomeBase,
    JARVIS_CLI_RUNNER_SOCKET: config.cliRunnerSocketPath,
    JARVIS_CLI_TOOLS_PREFIX: env.JARVIS_CLI_TOOLS_PREFIX ?? env.NPM_CONFIG_PREFIX ?? ""
  });

  const child = spawn("node_modules/.bin/tsx", ["packages/cli-runner/src/main-entry.ts"], {
    detached: true,
    env: childEnv,
    stdio: "ignore"
  });
  child.unref();
}

/**
 * Probe first; spawn only if nothing answers; then re-probe on a bounded schedule and report
 * whatever is true at the end of it. Returns `reachable:false` rather than waiting forever.
 */
export async function ensureCliRunnerRunning(
  config: DevInstanceConfig,
  env: NodeJS.ProcessEnv,
  overrides: Partial<EnsureCliRunnerDeps> = {}
): Promise<CliRunnerStatus> {
  const probe =
    overrides.probe ?? ((socketPath, rpcSecret) => probeCliRunner(socketPath, rpcSecret));
  const spawnRunner = overrides.spawnRunner ?? spawnDevCliRunner;
  const delay = overrides.delay ?? sleep;
  const rpcSecret = env.JARVIS_CLI_RUNNER_RPC_SECRET;

  const first = await probe(config.cliRunnerSocketPath, rpcSecret);
  if (first.reachable) return first;

  // A missing socket directory can never be fixed by spawning — the runner would fail to bind for
  // the same reason. Hand back the instruction instead of a process that dies immediately.
  if (first.detail.includes(RUN_DIR_REPAIR_COMMAND)) return first;

  spawnRunner(config, env);

  let latest = first;
  for (let attempt = 0; attempt < START_PROBE_ATTEMPTS; attempt += 1) {
    await delay(START_PROBE_INTERVAL_MS);
    latest = await probe(config.cliRunnerSocketPath, rpcSecret);
    if (latest.reachable) return latest;
  }

  return {
    detail: `started a cli-runner but gave up after ${START_PROBE_ATTEMPTS} checks: ${latest.detail}`,
    reachable: false,
    socketPath: config.cliRunnerSocketPath
  };
}
