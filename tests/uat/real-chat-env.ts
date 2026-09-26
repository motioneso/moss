// tests/uat/real-chat-env.ts
//
// #2732: retires the #1121 stored-token path (a GPG-encrypted, once-persisted Anthropic token
// that stopped working in July — provider-login/begin stalled at "awaiting_token" for good).
// The replacement, proven live against a real throwaway stack in #2721, copies the HOST's own
// signed-in Codex CLI login into the stack instead of asking anyone to mint and store a
// dedicated-account token. This is credential-handling code and the only part of UAT
// provisioning that touches secret material — a separate file, not folded into provisioner.ts.
//
// Trigger: a real Codex login file on the operator's own machine (~/.codex/auth.json by
// default). A CI box has no such file, so real-chat runs stay opt-in and CI stays
// credential-free without a separate on/off switch. The file's bytes travel from this process
// into the container over stdin only — never through an argv, an env var, a temp file on disk,
// or a log line — and the copy inside the container is removed at teardown.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST_CODEX_AUTH_FILE_ENV = "JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE";

/** Path to the host's own Codex login file. Overridable for tests; ~/.codex/auth.json by default. */
export function hostCodexAuthPath(): string {
  return process.env[HOST_CODEX_AUTH_FILE_ENV] ?? join(homedir(), ".codex", "auth.json");
}

// #1121 precedent kept: the harness sets this on its own process env once real chat is
// configured for a run, and run-uat.ts spawns Playwright with `...process.env`, so every spec
// can read it as the single "was a real chat model configured for THIS run" signal.
export const REAL_CHAT_CONFIGURED_ENV = "JARVIS_UAT_REAL_CHAT_CONFIGURED";

export interface UatRealChatCodexAuth {
  /** Removes the copied credential from the container. Safe to call more than once. */
  readonly cleanup: () => Promise<void>;
}

interface UidSlot {
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

const UID_SLOT_RE = /^\{.*\}$/s;
const OWNER_RE = /^\d+:\d+$/;

function execDockerCompose(
  buildComposeArgs: (extra: readonly string[]) => readonly string[],
  extra: readonly string[],
  input?: Buffer
): string {
  // #2732: stdio is fully piped (never "inherit") so a credential passed via `input` can never
  // land on this process's own stdout/stderr — the proven shape from the #2721 proof script.
  return execFileSync("docker", buildComposeArgs(extra), {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
    maxBuffer: 10 * 1024 * 1024
  }).trim();
}

/**
 * #2732: opt-in (see hostCodexAuthPath) — a no-op unless the host itself has a Codex login.
 * Derives the cli-auth volume's owner UID/GID inside the running stack, allocates `actorUserId`
 * an owner-scoped slot the same way a real per-user chat launch would, and writes the host's
 * auth.json into that slot's ~/.codex/auth.json over stdin at mode 0600 — proven live in #2721.
 * Throws (never silently skips) if the host file exists but the copy fails, so a misconfigured
 * run fails loudly instead of quietly running with no real model.
 */
export function installUatRealChatCodexAuth(
  projectName: string,
  actorUserId: string,
  buildComposeArgs: (extra: readonly string[]) => readonly string[]
): UatRealChatCodexAuth | undefined {
  const authPath = hostCodexAuthPath();
  if (!existsSync(authPath)) {
    return undefined;
  }

  const owner = execDockerCompose(buildComposeArgs, [
    "exec",
    "-T",
    "jarv1s",
    "stat",
    "-c",
    "%u:%g",
    "/data/cli-auth"
  ]);
  if (!OWNER_RE.test(owner)) {
    throw new Error(`[uat real-chat] invalid cli-auth owner metadata for ${projectName}`);
  }

  // Mirrors packages/cli-runner/src/uid-allocator.ts's allocateUidSlot exactly, run inside the
  // container (as the volume's owner) so the slot file's own ownership never needs to change.
  const slotScript =
    "import { allocateUidSlot } from './packages/cli-runner/src/uid-allocator.ts'; " +
    "import { mkdirSync } from 'node:fs'; " +
    "const base='/data/cli-auth'; " +
    `const user=${JSON.stringify(actorUserId)}; ` +
    "const slot=allocateUidSlot(base,user); " +
    "mkdirSync(base+'/agents',{recursive:true,mode:0o711}); " +
    "const home=base+'/agents/'+user; " +
    "mkdirSync(home,{recursive:true,mode:0o700}); " +
    "console.log(JSON.stringify({...slot,home}));";
  const slotOutput = execDockerCompose(buildComposeArgs, [
    "exec",
    "-T",
    "--user",
    owner,
    "jarv1s",
    "node_modules/.bin/tsx",
    "-e",
    slotScript
  ]);
  if (!UID_SLOT_RE.test(slotOutput)) {
    throw new Error(`[uat real-chat] unexpected uid-slot output for ${projectName}`);
  }
  const slot = JSON.parse(slotOutput) as UidSlot;

  // The existing container CHOWN capability hands over only this newly created actor directory.
  execDockerCompose(buildComposeArgs, [
    "exec",
    "-T",
    "--user",
    "0:0",
    "jarv1s",
    "chown",
    `${slot.uid}:${slot.gid}`,
    slot.home
  ]);

  const writeScript =
    "const fs=require('node:fs');const d=process.argv[1]+'/.codex';" +
    "fs.mkdirSync(d,{recursive:true,mode:0o700});" +
    "fs.writeFileSync(d+'/auth.json',fs.readFileSync(0),{mode:0o600});";
  try {
    execDockerCompose(
      buildComposeArgs,
      [
        "exec",
        "-T",
        "--user",
        `${slot.uid}:${slot.gid}`,
        "jarv1s",
        "node",
        "-e",
        writeScript,
        slot.home
      ],
      readFileSync(authPath)
    );
  } catch {
    throw new Error(`[uat real-chat] owner-scoped Codex credential copy failed for ${projectName}`);
  }

  let removed = false;
  return {
    cleanup: async () => {
      if (removed) return;
      removed = true;

      // The owner-scoped slot copy this run wrote above.
      let ownerCopyFailed = false;
      try {
        execDockerCompose(buildComposeArgs, [
          "exec",
          "-T",
          "--user",
          `${slot.uid}:${slot.gid}`,
          "jarv1s",
          "rm",
          "-f",
          `${slot.home}/.codex/auth.json`
        ]);
      } catch {
        ownerCopyFailed = true;
      }

      // The already-authenticated sign-in path (see login-service.ts / main.ts's
      // onLoginReady) promotes this same login into the instance's shared Codex login at
      // /data/cli-auth/.codex/auth.json, the same file real per-user launches read. That
      // copy — and any temp file its writer leaves on a crash mid-write — must be gone too,
      // not just the owner-scoped one, or another launch can go on inheriting this run's
      // credential after the stack is torn down.
      let sharedCopyFailed = false;
      try {
        execDockerCompose(buildComposeArgs, [
          "exec",
          "-T",
          "--user",
          owner,
          "jarv1s",
          "sh",
          "-c",
          "rm -f /data/cli-auth/.codex/auth.json /data/cli-auth/.codex/.auth.json.*.tmp"
        ]);
      } catch {
        sharedCopyFailed = true;
      }

      if (ownerCopyFailed || sharedCopyFailed) {
        // Fixed message, no credential content: this can surface in CI logs.
        throw new Error(
          `[uat real-chat] credential cleanup failed for ${projectName}; a copied Codex ` +
            "login may remain in the stack's volume"
        );
      }
    }
  };
}
