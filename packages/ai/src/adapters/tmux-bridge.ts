import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { type ProviderKind } from "./transcript-reader.js";

// ─── Public interface ────────────────────────────────────────────────────────

export interface RunOptions {
  /** Extra environment variables, merged over process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  readonly cwd?: string;
}

export interface TmuxIo {
  /** Run an external command; resolve to { code, stdout }. */
  run(
    cmd: string,
    args: readonly string[],
    opts?: RunOptions
  ): Promise<{ code: number; stdout: string; stderr?: string }>;
  /** Read a file path to a string (may throw if not yet created). */
  readFile(path: string): Promise<string>;
  /** Write a string to a file path (overwrites). */
  writeFile(path: string, content: string): Promise<void>;
  /** Non-blocking sleep. */
  sleep(ms: number): Promise<void>;
}

const execFileAsync = promisify(execFile);

/**
 * The real TmuxIo backed by node:child_process and node:fs/promises. This is the
 * single shared production implementation used by both TmuxBridgeAdapter (one-shot
 * turns) and the live persistent-session engine; tests inject a fake instead.
 */
export function createRealTmuxIo(baseEnv: NodeJS.ProcessEnv = process.env): TmuxIo {
  return {
    run: async (cmd, args, opts) => {
      // Use execFile (not exec) so arguments are passed directly to the process
      // without a shell re-parsing them. A shell join would mangle args containing
      // spaces, quotes, pipes, or redirects (e.g. the `bash -c "<pipeline>"` calls).
      try {
        const { stdout, stderr } = await execFileAsync(cmd, [...args], {
          env: opts?.env ? { ...baseEnv, ...opts.env } : baseEnv,
          cwd: opts?.cwd
        });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr
        };
      }
    },
    async readFile(path: string): Promise<string> {
      return readFile(path, "utf8");
    },
    async writeFile(path: string, content: string): Promise<void> {
      await writeFile(path, content, "utf8");
    },
    async sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
  };
}

/**
 * Resolve the path of the JSONL transcript that the CLI writes during an
 * interactive session.  These paths were discovered from real installs:
 *
 * - anthropic / Claude Code:
 *     Writes a JSONL file per session under
 *     ~/.claude/projects/<url-encoded-cwd>/<uuid>.jsonl
 *     We cannot know the session UUID before the session starts, so we look
 *     for the most-recently-modified *.jsonl under the project directory.
 *
 * - openai-compatible / Codex:
 *     Writes session rolls under
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl
 *     Again, use the newest file under today's directory.
 *
 * - google / Gemini CLI:
 *     Writes session chats under
 *     ~/.gemini/tmp/<lowercase-project-dir-basename>/chats/session-<ISO>-<uuid>.jsonl
 *     Use the newest file under the chats directory for the given project dir.
 */
export function transcriptGlobDir(
  provider: ProviderKind,
  cwd: string,
  homeBase: string = homedir()
): string {
  switch (provider) {
    case "anthropic": {
      // Claude Code encodes the project dir by replacing EVERY character outside
      // [a-zA-Z0-9-] with "-", and KEEPS the leading "-" (an absolute path starts
      // with "/"). Case is preserved and runs of separators are NOT collapsed, so
      //   /home/USER/Jarv1s/.claude/worktrees/x -> -home-USER-Jarv1s--claude-worktrees-x
      //
      // #1353: this used to replace only "/" and "." — which is right for an ordinary
      // repo path and wrong for the live-chat neutral dir, whose session key carries a
      // surface suffix (`<userId>:drawer`). The engine then polled
      // `…-<uuid>:drawer/<id>.jsonl` while Claude wrote `…-<uuid>-drawer/<id>.jsonl`,
      // so every read was ENOENT, the turn produced nothing for 180s, and the idle
      // watchdog returned an empty reply with no message ever persisted. Prod chat was
      // down on exactly this. Keep the character class in sync with Claude Code.
      const encoded = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
      return join(homeBase, ".claude", "projects", encoded);
    }
    case "openai-compatible": {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      return join(homeBase, ".codex", "sessions", String(y), m, d);
    }
    case "google": {
      // #2028 — best effort, and only the long-lived multiplexer path still asks for it. The real
      // Gemini CLI names this directory by a short id of its own that lives only in
      // ~/.gemini/projects.json, so it cannot be computed from the folder name. The one-shot
      // engine that Google chat actually runs does not use this at all: it reads the reply from
      // the process's own output instead.
      const projectDir = basename(cwd).toLowerCase();
      return join(homeBase, ".gemini", "tmp", projectDir, "chats");
    }
  }
}
