/**
 * Default resolution for the tools-volume prefix (`NPM_CONFIG_PREFIX` / `JARVIS_CLI_TOOLS_PREFIX`,
 * §7.1). Used only when neither env var is set — see `main.ts`'s `readConfig` and
 * `install-service.ts`'s `InstallService` constructor.
 *
 * #2340: `MACHINE_TOOLS_PREFIX` sits at the filesystem root and needs root to create on a box
 * that has never run the Docker image (the documented from-source dev path). `MANAGED_TOOLS_PREFIX`
 * follows the same per-user convention as `resolveChatHome` (`packages/chat/src/live/chat-home.ts`)
 * so a fresh, unprivileged account has a folder it can actually create.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MANAGED_TOOLS_PREFIX = join(homedir(), ".jarvis", "cli-tools");
export const MACHINE_TOOLS_PREFIX = "/data/cli-tools";

/**
 * Look in the managed (per-user) tools folder first; fall back to the machine-root folder only
 * if it already has an installed `bin` (a box provisioned the old way keeps working). A genuinely
 * fresh account, where neither exists yet, gets the managed folder.
 *
 * `managed`/`machine` are overridable (tests only — real callers take the module-level defaults)
 * so the "already provisioned" branches are testable without root or a real home directory.
 */
export function resolveDefaultToolsPrefix(
  managed: string = MANAGED_TOOLS_PREFIX,
  machine: string = MACHINE_TOOLS_PREFIX
): string {
  if (existsSync(join(managed, "bin"))) return managed;
  if (existsSync(join(machine, "bin"))) return machine;
  return managed;
}
