import type { CliToolVersions } from "./cli-tool-versions.js";
import type { ProviderKind } from "./cli-availability.js";

/**
 * #2689 slice 4: the refresh pass. It runs in the API process because only that process holds
 * the cli-runner connection. Every collaborator is injected so this file imports nothing from
 * module-registry.
 */

export interface RefreshManifestPackage {
  readonly role: "cli" | "chat-adapter";
  readonly pkg: string;
  readonly version: string;
  readonly lockfile: string;
}

export interface RefreshManifest {
  readonly sequence: number;
  readonly toolsets: Readonly<
    Record<
      string,
      { readonly minMossVersion: string; readonly packages: readonly RefreshManifestPackage[] }
    >
  >;
}

export type RefreshFetchResult =
  | {
      readonly ok: true;
      readonly manifest: RefreshManifest;
      readonly lockfiles: Readonly<Record<string, Uint8Array>>;
    }
  | { readonly ok: false; readonly reason: string };

export interface RefreshRunnerState {
  readonly manifestSequence: number;
  readonly candidates: Readonly<
    Record<string, readonly { readonly pkg: string; readonly version: string }[]>
  >;
}

export interface RefreshStagePackage {
  readonly role: "cli" | "chat-adapter";
  readonly pkg: string;
  readonly version: string;
  readonly lockfileText: string;
}

export interface CliToolsRefreshPorts {
  readonly getState: () => Promise<RefreshRunnerState | null>;
  readonly listVersions: () => Promise<CliToolVersions | undefined>;
  readonly fetchManifest: (lastSequence: number) => Promise<RefreshFetchResult>;
  readonly stage: (params: {
    readonly provider: ProviderKind;
    readonly manifestSequence: number;
    readonly packages: readonly RefreshStagePackage[];
  }) => Promise<
    { readonly state: "staged" } | { readonly state: "error"; readonly message: string }
  >;
  readonly compareVersions: (a: string, b: string) => number;
  /** Version of this Moss build. `undefined` when it cannot be read. */
  readonly mossVersion: () => string | undefined;
}

export type SkipReason = "not-newer" | "already-staged" | "needs-newer-moss";

export interface CliToolsRefreshOutcome {
  readonly status: "ok" | "runner-unavailable" | "fetch-failed" | "up-to-date";
  readonly reason?: string;
  readonly staged: readonly string[];
  readonly skipped: Readonly<Record<string, SkipReason>>;
  /** Toolsets held for a newer Moss, with the tool version that is waiting. */
  readonly needsNewerMoss?: Readonly<Record<string, string>>;
  readonly failed: readonly string[];
}

const PROVIDERS: readonly ProviderKind[] = ["anthropic", "openai-compatible", "google"];
const EMPTY = { staged: [], skipped: {}, failed: [] } as const;

function isProvider(name: string): name is ProviderKind {
  return (PROVIDERS as readonly string[]).includes(name);
}

/**
 * Fetch the signed manifest and stage every toolset that is newer than the live one. The
 * sequence is recorded only after every toolset staged, so a failed stage is retried next pass.
 * Never throws.
 */
export async function runCliToolsRefresh(
  ports: CliToolsRefreshPorts
): Promise<CliToolsRefreshOutcome> {
  try {
    const state = await ports.getState();
    if (!state) return { status: "runner-unavailable", ...EMPTY };

    const fetched = await ports.fetchManifest(state.manifestSequence);
    if (!fetched.ok) {
      return fetched.reason === "sequence-not-newer"
        ? { status: "up-to-date", ...EMPTY }
        : { status: "fetch-failed", reason: fetched.reason, ...EMPTY };
    }

    const versions = await ports.listVersions();
    const moss = ports.mossVersion();
    const staged: string[] = [];
    const failed: string[] = [];
    const skipped: Record<string, SkipReason> = {};
    const needsNewerMoss: Record<string, string> = {};
    const decoder = new TextDecoder();

    for (const [name, toolset] of Object.entries(fetched.manifest.toolsets)) {
      if (!isProvider(name)) continue;
      const cli = toolset.packages.find((p) => p.role === "cli");
      if (!cli) continue;

      if (moss === undefined || ports.compareVersions(toolset.minMossVersion, moss) > 0) {
        skipped[name] = "needs-newer-moss";
        needsNewerMoss[name] = cli.version;
        continue;
      }
      const live = versions?.providers[name] ?? null;
      if (live !== null && ports.compareVersions(cli.version, live) <= 0) {
        skipped[name] = "not-newer";
        continue;
      }
      if (
        (state.candidates[name] ?? []).some((c) => c.pkg === cli.pkg && c.version === cli.version)
      ) {
        skipped[name] = "already-staged";
        continue;
      }

      const packages: RefreshStagePackage[] = [];
      for (const p of toolset.packages) {
        const lock = fetched.lockfiles[p.lockfile];
        if (!lock) break;
        packages.push({
          role: p.role,
          pkg: p.pkg,
          version: p.version,
          lockfileText: decoder.decode(lock)
        });
      }
      if (packages.length !== toolset.packages.length) {
        failed.push(name);
        continue;
      }

      // Staging passes the old sequence so a failure elsewhere leaves this manifest retryable.
      const result = await ports.stage({
        provider: name,
        manifestSequence: state.manifestSequence,
        packages
      });
      if (result.state === "staged") staged.push(name);
      else failed.push(name);
    }

    // A toolset held for a newer Moss keeps the manifest unrecorded, so it is looked at again
    // after Moss is upgraded instead of waiting for the next published sequence.
    if (failed.length === 0 && Object.keys(needsNewerMoss).length === 0) {
      const recorded = await ports.stage({
        provider: "anthropic",
        manifestSequence: fetched.manifest.sequence,
        packages: []
      });
      if (recorded.state !== "staged") failed.push("sequence");
    }
    return { status: "ok", staged, skipped, needsNewerMoss, failed };
  } catch (err) {
    return {
      status: "fetch-failed",
      reason: err instanceof Error ? err.message : "unknown",
      ...EMPTY
    };
  }
}

export const CLI_TOOLS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Run once now, then every six hours. Returns a stop function. */
export function startCliToolsRefreshTimer(
  run: () => Promise<unknown>,
  intervalMs: number = CLI_TOOLS_REFRESH_INTERVAL_MS
): () => void {
  const tick = () => void run().catch(() => undefined);
  const first = setTimeout(tick, 30_000);
  const every = setInterval(tick, intervalMs);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
