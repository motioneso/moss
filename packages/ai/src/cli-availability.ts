import { exec } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveMossEnv } from "@moss/db";

const execAsync = promisify(exec);

export type ProviderKind = "anthropic" | "openai-compatible" | "google";

export interface WhichDeps {
  which: (binary: string) => Promise<string | null>;
  /**
   * Optional env override (defaults to process.env). When set, the
   * operator-declared host-CLI contract (JARVIS_HOST_CLIS) is consulted BEFORE
   * the local PATH probe.
   */
  env?: NodeJS.ProcessEnv;
}

// #2028 — google's primary command is `gemini`. It used to be the Antigravity command, which
// nothing this project installs has ever put on PATH, so a working Gemini install reported as
// missing and the chat path launched a binary that was not there.
const PROVIDER_BINARY: Record<ProviderKind, string> = {
  anthropic: "claude",
  "openai-compatible": "codex",
  google: "gemini"
};

// Additional binary names operators may declare for a kind. install.sh records whichever binary it
// finds on PATH. The old Antigravity name stays accepted here so a host that already declared it
// in JARVIS_HOST_CLIS keeps resolving; nothing builds a command from it any more.
const PROVIDER_BINARY_ALIASES: Record<ProviderKind, readonly string[]> = {
  anthropic: [],
  "openai-compatible": [],
  google: ["agy"]
};

async function defaultWhich(
  binary: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const prefix = resolveMossEnv(env, "JARVIS_CLI_TOOLS_PREFIX");
  if (prefix) {
    const installed = join(prefix, "bin", binary);
    try {
      await access(installed, constants.X_OK);
      if ((await stat(installed)).isFile()) return installed;
    } catch {
      // An absent managed install can still be supplied by the host PATH.
    }
  }
  try {
    const { stdout } = await execAsync(`command -v ${binary}`, { env });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Operator-declared host-CLI contract (ADR 0008 containerized deploy): the API
 * container cannot see host-installed CLIs (only their auth/config dirs are
 * mounted, never the binaries), so install.sh records which CLIs it detected on
 * the host into `JARVIS_HOST_CLIS` (comma-separated binary names, e.g.
 * "claude,codex,gemini"). Returns whether `providerKind`'s binary is declared,
 * or `null` when the contract is unset/empty so the caller falls back to the
 * local PATH probe (the non-containerized/host-install + test path).
 */
function declaredHostCliAvailable(
  env: NodeJS.ProcessEnv,
  providerKind: ProviderKind
): boolean | null {
  const raw = resolveMossEnv(env, "JARVIS_HOST_CLIS");
  if (raw === undefined || raw.trim() === "") return null;
  const declared = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const names = [PROVIDER_BINARY[providerKind], ...PROVIDER_BINARY_ALIASES[providerKind]].map(
    (name) => name.toLowerCase()
  );
  return declared.some((name) => names.includes(name));
}

/**
 * Returns true if the CLI binary for the given provider kind is present.
 * Presence-only — no auth probing. In a containerized deploy, consults the
 * operator-declared `JARVIS_HOST_CLIS` contract FIRST (the container cannot see
 * host CLIs); when that is unset/empty it checks the managed tools prefix, then the local PATH
 * `command -v` probe, which tries the kind's primary binary and then its
 * aliases (unchanged behavior for host installs + tests: the primary name is
 * still probed first).
 */
export async function cliAvailable(providerKind: ProviderKind, deps?: WhichDeps): Promise<boolean> {
  const env = deps?.env ?? process.env;
  const declared = declaredHostCliAvailable(env, providerKind);
  if (declared !== null) return declared;
  const which = deps?.which ?? ((binary: string) => defaultWhich(binary, env));
  // #2026/#2028: try the primary name first, then the kind's aliases. The installed Gemini package
  // only ever produces a command called `gemini`, so probing the old Antigravity name alone
  // reported a successful install as missing forever.
  for (const binary of [PROVIDER_BINARY[providerKind], ...PROVIDER_BINARY_ALIASES[providerKind]]) {
    if ((await which(binary)) !== null) return true;
  }
  return false;
}

/**
 * Returns true if the tmux binary is present on PATH.
 * No auth probing is performed — presence only.
 */
export async function tmuxAvailable(deps?: WhichDeps): Promise<boolean> {
  const which = deps?.which ?? defaultWhich;
  const result = await which("tmux");
  return result !== null;
}

/**
 * Returns true if the herdr binary is present on PATH.
 * No auth probing is performed — presence only (same posture as tmuxAvailable/cliAvailable).
 */
export async function herdrAvailable(deps?: WhichDeps): Promise<boolean> {
  const which = deps?.which ?? defaultWhich;
  const result = await which("herdr");
  return result !== null;
}
