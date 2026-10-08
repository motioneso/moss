import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { StructuredChildIdentity } from "./structured-claude-engine.js";

export type ConstrainedProcessFailure =
  | "launch"
  | "cancelled"
  | "timeout"
  | "output_limit"
  | "input_limit"
  | "protocol"
  | "exit"
  | "termination"
  | "cleanup";

/** Child diagnostics can contain credentials and prompts. Never attach them, even as a cause. */
export class ConstrainedProcessError extends Error {
  /** Internal-only recovery; never serialized with errors or exposed over RPC. */
  declare readonly retryCleanup?: () => Promise<void>;

  constructor(
    readonly code: ConstrainedProcessFailure,
    retryCleanup?: () => Promise<void>
  ) {
    super(`Structured model process failed: ${code}`);
    this.name = "ConstrainedProcessError";
    if (retryCleanup) Object.defineProperty(this, "retryCleanup", { value: retryCleanup });
  }
}

export interface ConstrainedProcessControls {
  /** Writes a prompt or protocol frame verbatim to stdin, never argv. */
  write(frame: string): void;
  end(): void;
  /** The protocol delivered its final result; stop the process and its group. */
  complete(): void;
}

export interface ConstrainedStructuredProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Already allowlisted by the caller; the parent environment is never inherited. */
  env: Readonly<NodeJS.ProcessEnv>;
  identity?: StructuredChildIdentity;
  input?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxStdinBytes?: number;
  signal?: AbortSignal;
  /** Synchronous JSON-lines handler. Without it, initial input is followed by EOF. */
  onStdoutLine?: (line: string, controls: ConstrainedProcessControls) => void;
}

export interface ConstrainedStructuredProcessResult {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** A fresh, bounded process group for one structured request, with no diagnostic logging. */
export async function runConstrainedStructuredProcess(
  options: ConstrainedStructuredProcessOptions
): Promise<ConstrainedStructuredProcessResult> {
  const { identity } = options;
  let releaseAllowed = true;
  let identityReleased = false;
  let releasing: Promise<void> | undefined;
  const releaseIdentity = (): Promise<void> => {
    if (identityReleased) return Promise.resolve();
    releasing ??= Promise.resolve()
      .then(() => identity?.release())
      .then(() => {
        identityReleased = true;
      })
      .catch(() => {
        releasing = undefined;
        throw new ConstrainedProcessError("cleanup");
      });
    return releasing;
  };
  try {
    for (const limit of [
      options.timeoutMs,
      options.maxStdoutBytes,
      options.maxStderrBytes,
      options.maxStdinBytes ?? 2 * 1024 * 1024
    ]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new ConstrainedProcessError("launch");
    }
    if (options.signal?.aborted) throw new ConstrainedProcessError("cancelled");
    const env = { ...options.env, ...identity?.env };
    // bash -c must not execute hooks before entering the isolated account's working directory.
    for (const key of Object.keys(env)) {
      if (
        ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH"].includes(key) ||
        key.startsWith("BASH_FUNC_")
      ) {
        delete env[key];
      }
    }
    // No spawn cwd: the identity wrapper switches uid before bash enters this directory.
    const command = "/bin/bash";
    const args = [
      "--noprofile",
      "--norc",
      "-c",
      'cd -- "$1" && shift && exec "$@"',
      "structured-model",
      options.cwd,
      options.command,
      ...options.args
    ];
    let launch: { command: string; args: readonly string[] };
    try {
      launch = identity?.wrap(command, args) ?? { command, args };
    } catch {
      throw new ConstrainedProcessError("launch");
    }
    return await new Promise<ConstrainedStructuredProcessResult>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { env, detached: true, stdio: "pipe" });
      let failure: ConstrainedProcessFailure | undefined;
      let completed = false;
      let closed = false;
      let markClosed!: () => void;
      const actualClose = new Promise<void>((resolveClose) => {
        markClosed = resolveClose;
      });
      let recovery: Promise<void> | undefined;
      const groupGone = (): boolean => {
        if (!child.pid) return true;
        try {
          process.kill(-child.pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      };
      const retryCleanup = (): Promise<void> => {
        if (identityReleased) return Promise.resolve();
        if (recovery) return recovery;
        let expired = false;
        let recoveryTimer: ReturnType<typeof setTimeout>;
        const work = (async () => {
          let confirmedSignal = false;
          // A later recovery never re-signals an exited leader: that PID may have been reused.
          if (!closed && child.exitCode === null && child.signalCode === null && child.pid) {
            try {
              if (identity) await identity.signalGroup(child.pid, "SIGKILL");
              else process.kill(-child.pid, "SIGKILL");
              confirmedSignal = true;
            } catch {
              /* Only verified disappearance permits cleanup after a failed signal. */
            }
          }
          await actualClose;
          if (expired || (!confirmedSignal && !groupGone())) {
            throw new ConstrainedProcessError("termination", retryCleanup);
          }
          await releaseIdentity();
        })();
        const deadline = new Promise<never>((_, rejectRecovery) => {
          recoveryTimer = setTimeout(() => {
            expired = true;
            rejectRecovery(new ConstrainedProcessError("termination", retryCleanup));
          }, 2000);
        });
        recovery = Promise.race([work, deadline]).finally(() => {
          clearTimeout(recoveryTimer);
          recovery = undefined;
        });
        return recovery;
      };
      const processError = (code: ConstrainedProcessFailure): ConstrainedProcessError =>
        new ConstrainedProcessError(code, code === "termination" ? retryCleanup : undefined);
      let termination: Promise<void> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdinBytes = 0;
      const output: Buffer[] = [];
      const decoder = new StringDecoder("utf8");
      let pendingLine = "";
      const terminate = (): Promise<void> => {
        if (termination) return termination;
        // Bound the entire shutdown, including a stuck identity helper or missing child close.
        stopTimer = setTimeout(() => {
          failure = "termination";
          releaseAllowed = false;
          // A cancellation may beat the uid switch, while this group is still ours.
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            /* no authority */
          }
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          reject(processError("termination"));
        }, 2000);
        termination = (async () => {
          if (!child.pid) return;
          try {
            if (identity) await identity.signalGroup(child.pid, "SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            // A failed owner-account signal may mean the wrapper has not switched uid yet.
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* check without assuming */
            }
            let groupGone = (error as NodeJS.ErrnoException).code === "ESRCH";
            if (!groupGone) {
              // The uid-switching helper can wrap ESRCH in a generic exit-code error.
              // EPERM means the other account still owns a live group, not that it is gone.
              try {
                process.kill(-child.pid, 0);
              } catch (probeError) {
                groupGone = (probeError as NodeJS.ErrnoException).code === "ESRCH";
              }
            }
            if (!groupGone) {
              failure = "termination";
              // Do not delete the account's files when termination could not be established.
              releaseAllowed = false;
              clearTimeout(stopTimer);
              clearTimeout(timer);
              options.signal?.removeEventListener("abort", abort);
              reject(processError("termination"));
            }
          }
        })();
        return termination;
      };
      const fail = (code: ConstrainedProcessFailure): void => {
        failure ??= code;
        void terminate();
      };
      const controls: ConstrainedProcessControls = {
        write(frame) {
          if (closed || failure || completed) return;
          stdinBytes += Buffer.byteLength(frame);
          if (stdinBytes > (options.maxStdinBytes ?? 2 * 1024 * 1024)) {
            fail("input_limit");
            return;
          }
          child.stdin.write(frame);
        },
        end() {
          child.stdin.end();
        },
        complete() {
          completed = true;
          void terminate();
        }
      };
      const emitLine = (line: string): void => {
        if (failure || completed) return;
        try {
          options.onStdoutLine?.(line, controls);
        } catch {
          fail("protocol");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure || completed) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > options.maxStdoutBytes) {
          fail("output_limit");
          return;
        }
        output.push(chunk);
        if (options.onStdoutLine) {
          pendingLine += decoder.write(chunk);
          let newline: number;
          while ((newline = pendingLine.indexOf("\n")) >= 0 && !failure && !completed) {
            const line = pendingLine.slice(0, newline).replace(/\r$/, "");
            pendingLine = pendingLine.slice(newline + 1);
            emitLine(line);
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > options.maxStderrBytes) fail("output_limit");
      });
      child.stdin.on("error", () => {
        if (!completed && !closed) fail("protocol");
      });
      child.stdout.on("error", () => fail("protocol"));
      child.stderr.on("error", () => fail("protocol"));
      child.on("error", () => fail("launch"));
      // The original exit handler immediately stops the current group, including inherited pipes.
      // Later recovery only probes after exit rather than re-signalling a potentially reused PID.
      // This is not containment for descendants that deliberately create a new session/group.
      child.on("exit", () => {
        void terminate();
      });
      const abort = (): void => fail("cancelled");
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => fail("timeout"), options.timeoutMs);
      child.on("close", (exitCode, signal) => {
        closed = true;
        markClosed();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        void (async () => {
          await terminate();
          clearTimeout(stopTimer);
          if (!failure && !completed && options.onStdoutLine) {
            pendingLine += decoder.end();
            if (pendingLine) emitLine(pendingLine);
          }
          if (failure) reject(processError(failure));
          else if (!completed && exitCode !== 0) reject(new ConstrainedProcessError("exit"));
          else resolve({ stdout: Buffer.concat(output).toString("utf8"), exitCode, signal });
        })();
      });
      if (options.signal?.aborted) abort();
      if (options.input !== undefined) controls.write(options.input);
      if (!options.onStdoutLine) controls.end();
    });
  } catch (error) {
    if (error instanceof ConstrainedProcessError) throw error;
    throw new ConstrainedProcessError("launch");
  } finally {
    if (releaseAllowed) {
      await releaseIdentity();
    }
  }
}
