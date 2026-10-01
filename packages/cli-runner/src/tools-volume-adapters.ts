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

import { readToolsState } from "./tools-state.js";

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

/**
 * Release folder names, by install slot, that a launch uses instead of `current`. Built only from
 * the runner's own state file by `candidateReleasesFor`, never from caller input.
 */
export type ReleaseOverrides = ReadonlyMap<string, string>;

/** The staged candidate's release folder per slot, or null when the provider has no candidate. */
export async function candidateReleasesFor(
  toolsPrefix: string,
  kind: AdapterChatKind
): Promise<ReleaseOverrides | null> {
  const { cliSlot, adapterSlot } = TOOLS_VOLUME_ADAPTERS[kind];
  const state = await readToolsState(toolsPrefix, cliSlot);
  const bySlot = new Map(state.candidate.map((c) => [c.slot, c.release]));
  return bySlot.has(cliSlot) && bySlot.has(adapterSlot) ? bySlot : null;
}

/** The release folder a launch uses: the override for this slot, else `current`; null if none. */
function currentRelease(
  toolsPrefix: string,
  slot: string,
  overrides?: ReleaseOverrides
): string | null {
  try {
    const providersRoot = realpathSync(join(toolsPrefix, "providers"));
    const staged = overrides?.get(slot);
    const release = realpathSync(
      staged ? join(providersRoot, slot, "releases", staged) : join(providersRoot, slot, "current")
    );
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
  kind: AdapterChatKind,
  overrides?: ReleaseOverrides
): string | null {
  const spec = TOOLS_VOLUME_ADAPTERS[kind];
  const release = currentRelease(toolsPrefix, spec.adapterSlot, overrides);
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
export function resolveToolsVolumeCli(
  toolsPrefix: string,
  kind: AdapterChatKind,
  overrides?: ReleaseOverrides
): string | null {
  const spec = TOOLS_VOLUME_ADAPTERS[kind];
  const release = currentRelease(toolsPrefix, spec.cliSlot, overrides);
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
  kind: AcpProviderKind,
  overrides?: ReleaseOverrides
): void {
  if (!toolsPrefix || (kind !== "anthropic" && kind !== "openai")) return;
  const { cliEnvVar } = TOOLS_VOLUME_ADAPTERS[kind];
  if (env[cliEnvVar] !== undefined) return;
  const cli = resolveToolsVolumeCli(toolsPrefix, kind, overrides);
  if (cli) env[cliEnvVar] = cli;
}
