/**
 * Per-user home for structured one-shot launches (#2674).
 *
 * With per-user UIDs on, a structured call (briefings, email extraction, job scoring) runs as its
 * owner's slot, in the owner's own home, the same home and login ACP chat uses. It never touches
 * the shared auth home, and a call with no owner is refused before any side effect.
 */

import { spawn } from "node:child_process";
import { rmdir } from "node:fs/promises";
import { join } from "node:path";

import { transcriptGlobDir, type ProviderKind, type TmuxIo } from "@moss/ai";
import type { StructuredChildIdentity } from "@moss/chat/live";

import {
  ensureOwnedTopLevel,
  handOverOwnedFile,
  handOverOwnedPath,
  prepareOwnedPathWithOwnership,
  purgeOwnedPath,
  writeOwnedFile,
  type OwnershipApplier
} from "./owned-fs.js";
import { runAgentHomePrepareAsOwner } from "./agent-home-prepare-run.js";
import {
  CODEX_LOGIN_READ_LIMITS,
  codexPeerHomes,
  ownerCodexHomeAccess,
  syncCodexLoginIntoHome,
  type CodexHomeAccess
} from "./codex-shared-login.js";
import { readProviderCredentialEnv } from "./provider-token-store.js";
import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { buildSetprivDropCommand } from "./setpriv.js";
import { allocateUidSlot, uidSlotOwner } from "./uid-allocator.js";

const PERSONA_FILENAME = "persona.md";

export interface PerUserStructuredDeps {
  readonly homeBase: string;
  readonly neutralBase: string;
  /** Test seam; defaults to a real chown, which needs the runner's CAP_CHOWN. */
  readonly applyOwnership?: OwnershipApplier;
  /** Test seam for the setpriv folder removal. */
  readonly purgeOwnedPath?: typeof purgeOwnedPath;
  /** Test seam for preparing the owner's home; defaults to the same steps ACP chat uses. */
  readonly prepareOwnerHome?: (
    homeBase: string,
    owner: string,
    slot: { readonly uid: number; readonly gid: number }
  ) => Promise<string>;
  /** Test seam for a user's Codex login; defaults to access through the user's own account. */
  readonly codexHomeAccess?: (
    agentHome: string,
    identity: { readonly uid: number; readonly gid: number }
  ) => CodexHomeAccess;
}

/** The owner's per-user home, created and handed over exactly as ACP chat does it. */
async function prepareOwnerHome(
  homeBase: string,
  owner: string,
  slot: { readonly uid: number; readonly gid: number },
  applyOwnership?: OwnershipApplier
): Promise<string> {
  const agentsParent = (await prepareOwnedPathWithOwnership(homeBase, owner, ["agents"], 1)).path;
  return (await ensureOwnedTopLevel(owner, agentsParent, owner, slot.uid, slot.gid, applyOwnership))
    .path;
}

export interface PerUserStructuredLaunch {
  /** The owner's per-user home: HOME for the child, where their CLI login lives. */
  readonly agentHome: string;
  readonly neutralDir: string;
  /** Written and handed to the owner before launch, so the engine never writes it. */
  readonly personaPath: string;
  readonly childIdentity: StructuredChildIdentity;
  /** File and command io that runs as the owner, for the owner's folders the runner cannot enter. */
  readonly io: TmuxIo;
}

/** True for a launch that goes through the structured one-shot verbs. */
export function isStructuredLaunch(params: {
  readonly schema?: unknown;
  readonly needsStructuredOutput?: boolean;
}): boolean {
  return params.schema !== undefined || params.needsStructuredOutput === true;
}

/**
 * Prepare a structured launch to run as its owner. Call under the admission mutex: it allocates
 * the owner's UID slot. Throws, with no slot written, when the launch names no owner.
 */
export async function preparePerUserStructuredLaunch(
  deps: PerUserStructuredDeps,
  key: string,
  params: {
    readonly provider: string;
    readonly userId?: unknown;
    readonly schema?: unknown;
    readonly needsStructuredOutput?: boolean;
    readonly personaText?: string;
  }
): Promise<PerUserStructuredLaunch> {
  const owner = uidSlotOwner(key, params);
  const slot = allocateUidSlot(deps.homeBase, owner);
  const identity = { uid: slot.uid, gid: slot.gid };

  const agentHome = deps.prepareOwnerHome
    ? await deps.prepareOwnerHome(deps.homeBase, owner, identity)
    : await prepareOwnerHome(deps.homeBase, owner, identity, deps.applyOwnership);

  // #2687: Codex runs with the instance's shared login, copied into the owner's home after any
  // newer refresh another user holds is carried back to it. The same step after the call carries
  // a refresh this call made back to the shared login.
  const codexAccess = (home: string, id: { uid: number; gid: number }) =>
    deps.codexHomeAccess?.(home, id) ??
    ownerCodexHomeAccess(
      home,
      id,
      createOwnerIo(id, { limits: CODEX_LOGIN_READ_LIMITS }),
      runAgentHomePrepareAsOwner
    );
  const codexHome =
    params.provider === "openai-compatible" ? codexAccess(agentHome, identity) : undefined;
  if (codexHome) {
    await syncCodexLoginIntoHome(
      deps.homeBase,
      codexHome,
      codexPeerHomes(deps.homeBase, owner, codexAccess)
    );
  }

  // The working folder: persona written by the runner first, then both handed to the owner.
  const neutral = await prepareOwnedPathWithOwnership(deps.neutralBase, key, [key]);
  const neutralDir = neutral.path;
  const personaPath = join(neutralDir, PERSONA_FILENAME);
  const created = await writeOwnedFile(key, personaPath, params.personaText ?? "");
  await handOverOwnedFile(key, personaPath, created, slot.uid, slot.gid, deps.applyOwnership);
  await handOverOwnedPath(key, neutral.levels, slot.uid, slot.gid, deps.applyOwnership);

  // Same login source as ACP chat: the runner reads the saved token and hands it over in env.
  // With none saved, the CLI falls back to the login stored in the owner's own home.
  const credentialEnv = await readProviderCredentialEnv(
    deps.homeBase,
    params.provider as ProviderKind
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(credentialEnv)) {
    if (typeof value === "string") env[name] = value;
  }

  const purge = deps.purgeOwnedPath ?? purgeOwnedPath;
  return {
    agentHome,
    neutralDir,
    personaPath,
    io: createOwnerIo(identity, { home: agentHome }),
    childIdentity: {
      wrap: (command, args) => {
        const dropped = buildSetprivDropCommand(command, args, identity);
        return { command: dropped.command, args: [...dropped.args] };
      },
      signalGroup: (pid, signal) => signalGroupAs(pid, signal, identity),
      env,
      release: async () => {
        // Structured prompts can carry private module data, so the call's transcript in the
        // owner's home goes too (#981). The runner's own purge looks only in the shared home.
        await purge(transcriptGlobDir("anthropic", neutralDir, agentHome), identity).catch(
          () => undefined
        );
        if (codexHome) {
          await syncCodexLoginIntoHome(deps.homeBase, codexHome).catch(() => undefined);
        }
        await removeOwnedFolder(neutralDir, identity, purge).catch((err: unknown) => {
          console.warn(
            `[engine-host] ${key} working folder removal failed: ${
              err instanceof Error ? err.name : "UnknownError"
            }`
          );
        });
      }
    }
  };
}

/**
 * Signal a process group as its owning account. The runner's capabilities do not cover
 * signalling another account's process, so the runner's own Node binary sends it through
 * setpriv, as ACP's stop path does. The pid travels by env, never by argv.
 */
export async function signalGroupAs(
  pid: number,
  signal: NodeJS.Signals,
  identity: { readonly uid: number; readonly gid: number }
): Promise<void> {
  const { command, args } = buildSetprivDropCommand(
    process.execPath,
    [
      "-e",
      "process.kill(-Number(process.env.STRUCTURED_STOP_PID), process.env.STRUCTURED_STOP_SIGNAL)"
    ],
    identity
  );
  await new Promise<void>((resolve, reject) => {
    const stopper = spawn(command, args, {
      stdio: "ignore",
      env: {
        ...buildSanitizedCliEnv(process.env),
        STRUCTURED_STOP_PID: String(pid),
        STRUCTURED_STOP_SIGNAL: signal
      }
    });
    stopper.once("error", reject);
    stopper.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`stop command for pid ${pid} exited with code ${String(code)}`));
    });
  });
}

/**
 * Remove a folder the owner holds inside a runner-owned parent. The owner empties it, because the
 * runner cannot enter it. The owner cannot unlink it from the runner's parent, so that last step
 * fails as the owner and the runner removes the now-empty folder itself.
 */
export async function removeOwnedFolder(
  path: string,
  identity: { readonly uid: number; readonly gid: number },
  purge: typeof purgeOwnedPath = purgeOwnedPath
): Promise<void> {
  await purge(path, identity).catch(() => undefined);
  await rmdir(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

const READ_AS_OWNER =
  "process.stdout.write(require('node:fs').readFileSync(process.env.OWNER_IO_PATH))";
const WRITE_AS_OWNER =
  "const fs=require('node:fs');fs.writeFileSync(process.env.OWNER_IO_PATH,fs.readFileSync(0),{mode:0o600})";

/** Caps on one owner-run command: when it must finish, and how much it may print. */
export interface OwnerRunLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * Run a command, and with `limits`, kill it and report failure once it overruns its deadline or
 * prints past the cap.
 */
export function runBounded(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input: string,
  limits?: OwnerRunLimits
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const abort = (): void => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      finish(1);
    };
    const timer = limits ? setTimeout(abort, limits.timeoutMs) : undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (limits && stdout.length > limits.maxOutputBytes) abort();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (!limits || stderr.length < limits.maxOutputBytes) stderr += chunk;
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/**
 * Io for a launch's own files, run as the owner through setpriv. The runner's capabilities do not
 * cover reading or writing inside a folder it has handed over. Paths travel by env and content by
 * stdin or stdout, never by argv. With `limits`, every command is bounded by them. With `home`,
 * every command runs in the owner's home, where Codex finds its login.
 */
export function createOwnerIo(
  identity: { readonly uid: number; readonly gid: number },
  opts: { readonly limits?: OwnerRunLimits; readonly home?: string } = {}
): TmuxIo {
  const homeEnv = opts.home ? { HOME: opts.home, CODEX_HOME: join(opts.home, ".codex") } : {};
  const run = (
    cmd: string,
    args: readonly string[],
    extraEnv: NodeJS.ProcessEnv = {},
    input?: string
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const dropped = buildSetprivDropCommand(cmd, args, identity);
    const env = { ...buildSanitizedCliEnv(process.env), ...homeEnv, ...extraEnv };
    return runBounded(dropped.command, dropped.args, env, input ?? "", opts.limits);
  };
  return {
    run: async (cmd, args, opts) => {
      if (opts?.cwd === undefined) return run(cmd, args, opts?.env);
      // The runner cannot enter the owner's folder, so the change of folder runs as the owner.
      return run(
        "sh",
        ["-c", 'cd "$1" && shift && exec "$@"', "sh", opts.cwd, cmd, ...args],
        opts.env
      );
    },
    async readFile(path) {
      const result = await run(process.execPath, ["-e", READ_AS_OWNER], { OWNER_IO_PATH: path });
      if (result.code !== 0) throw new Error("could not read the file as its owner");
      return result.stdout;
    },
    async writeFile(path, content) {
      const result = await run(
        process.execPath,
        ["-e", WRITE_AS_OWNER],
        { OWNER_IO_PATH: path },
        content
      );
      if (result.code !== 0) throw new Error("could not write the file as its owner");
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}
