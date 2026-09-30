/**
 * Development-only shared-account mode (`MOSS_CLI_ALLOW_SHARED_UID`, gated on NODE_ENV in
 * main.ts). Agents run as the runner's own account and nothing switches identity.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { codexPeerHomes, type CodexHomeAccess } from "./codex-shared-login.js";

/**
 * Every other user's Codex home. Per-user mode finds them through the uid slot table. Shared mode
 * allocates no slots, so it lists the homes under `agents/` and reads each as the runner itself.
 */
export function codexPeerHomesFor(
  sharedMode: boolean,
  homeBase: string,
  exceptUserId: string | undefined,
  access: (agentHome: string, identity: { uid: number; gid: number }) => CodexHomeAccess
): CodexHomeAccess[] {
  if (!sharedMode) return codexPeerHomes(homeBase, exceptUserId, access);
  const agentsDir = join(homeBase, "agents");
  let names: string[];
  try {
    names = readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const self = runnerOwnIdentity();
  return names
    .filter((name) => name !== exceptUserId)
    .map((name) => access(join(agentsDir, name), self));
}

/** The runner's own account, used as the slot in shared-account mode. */
export function runnerOwnIdentity(): { uid: number; gid: number } {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("AcpHost: shared-account mode needs a POSIX host");
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

/**
 * The identity a boot sweep switches to for one marker. A shared-mode marker names the runner's
 * own account, which setpriv cannot switch to without root, so only shared mode reads it as no
 * switch. Per-user mode always switches.
 */
export function sweepIdentity(
  sharedMode: boolean,
  record: { readonly uid: number; readonly gid: number }
): { uid: number; gid: number } | null {
  if (sharedMode) {
    const self = runnerOwnIdentity();
    if (record.uid === self.uid && record.gid === self.gid) return null;
  }
  return { uid: record.uid, gid: record.gid };
}
