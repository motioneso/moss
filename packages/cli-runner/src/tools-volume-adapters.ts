/**
 * Tools-volume chat adapters (#2689 slice 2).
 *
 * The chat adapter and the provider CLI it drives are installed onto the tools volume by
 * the install service. At each adapter launch the runner looks there first and falls back
 * to the copy baked into the image. Both lookups return the concrete release folder the
 * `current` link points at right now, never the link itself, so a running session keeps
 * the files it started with even if `current` flips later.
 *
 * The tools volume is written only by the runner (install-service.ts), so these paths are
 * runner-chosen, never user-chosen. Each result is still required to resolve inside the
 * volume's `providers` folder, so a planted link cannot point a launch elsewhere.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import type { AcpProviderKind } from "@moss/acp";

/** The chat provider kinds that have an installable adapter package. */
export type AdapterChatKind = Extract<AcpProviderKind, "anthropic" | "openai">;

interface ToolsVolumeAdapter {
  /** Install slot of the CLI, and the binary it exposes. */
  readonly cliSlot: "anthropic" | "openai-compatible";
  readonly cliBinary: "claude" | "codex";
  /** The override variable the adapter reads to run an external CLI. */
  readonly cliEnvVar: "CLAUDE_CODE_EXECUTABLE" | "CODEX_PATH";
  /** Install slot and package entry of the adapter itself. */
  readonly adapterSlot: string;
  readonly adapterEntry: string;
}

export const TOOLS_VOLUME_ADAPTERS: Readonly<Record<AdapterChatKind, ToolsVolumeAdapter>> = {
  anthropic: {
    cliSlot: "anthropic",
    cliBinary: "claude",
    cliEnvVar: "CLAUDE_CODE_EXECUTABLE",
    adapterSlot: "anthropic-adapter",
    adapterEntry: "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
  },
  openai: {
    cliSlot: "openai-compatible",
    cliBinary: "codex",
    cliEnvVar: "CODEX_PATH",
    adapterSlot: "openai-compatible-adapter",
    adapterEntry: "node_modules/@agentclientprotocol/codex-acp/dist/index.js"
  }
};

/** The release folder `providers/<slot>/current` points at, or null when none is installed. */
function currentRelease(toolsPrefix: string, slot: string): string | null {
  try {
    const providersRoot = realpathSync(join(toolsPrefix, "providers"));
    const release = realpathSync(join(providersRoot, slot, "current"));
    return release.startsWith(providersRoot + sep) ? release : null;
  } catch {
    return null;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The adapter entry file inside the live adapter release, or null (run the image copy). */
export function resolveToolsVolumeAdapterEntry(
  toolsPrefix: string,
  kind: AdapterChatKind
): string | null {
  const spec = TOOLS_VOLUME_ADAPTERS[kind];
  const release = currentRelease(toolsPrefix, spec.adapterSlot);
  if (!release) return null;
  try {
    const entry = realpathSync(join(release, spec.adapterEntry));
    return entry.startsWith(release + sep) && isRegularFile(entry)
      ? join(release, spec.adapterEntry)
      : null;
  } catch {
    return null;
  }
}

/** The CLI binary path inside the live CLI release, or null (the bundled copy runs). */
export function resolveToolsVolumeCli(toolsPrefix: string, kind: AdapterChatKind): string | null {
  const spec = TOOLS_VOLUME_ADAPTERS[kind];
  const release = currentRelease(toolsPrefix, spec.cliSlot);
  if (!release) return null;
  const bin = join(release, "node_modules", ".bin", spec.cliBinary);
  try {
    accessSync(bin, constants.X_OK);
    return realpathSync(bin).startsWith(release + sep) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Point the adapter at the tools volume CLI through its override variable. A value already in
 * `env` (the scripted test provider) is kept, and with no CLI installed nothing is set so the
 * adapter runs its bundled copy.
 */
export function applyToolsVolumeCli(
  env: NodeJS.ProcessEnv,
  toolsPrefix: string | undefined,
  kind: AcpProviderKind
): void {
  if (!toolsPrefix || (kind !== "anthropic" && kind !== "openai")) return;
  const { cliEnvVar } = TOOLS_VOLUME_ADAPTERS[kind];
  if (env[cliEnvVar] !== undefined) return;
  const cli = resolveToolsVolumeCli(toolsPrefix, kind);
  if (cli) env[cliEnvVar] = cli;
}
