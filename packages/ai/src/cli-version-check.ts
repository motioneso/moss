import type { ProviderKind } from "./cli-availability.js";

/**
 * #2689 slice 4: the version check. It runs the live check against a staged candidate and
 * either promotes it or holds it back. Every collaborator is injected. The outcome comes from
 * the stored check record and the live check's pass or fail, never from model words.
 */

export type CheckReason =
  | "ok"
  | "tool_call_missing"
  | "structured_call_failed"
  | "timeout"
  | "check_unavailable"
  | "promote_failed";

export interface LiveCheckResult {
  readonly passed: boolean;
  readonly reason: CheckReason;
  /** Attempts the structured call needed. Recorded so format drift shows up early. */
  readonly attempts?: number;
}

export interface VersionCheckState {
  readonly candidate: readonly { readonly pkg: string; readonly version: string }[];
  readonly lastCheck: {
    readonly at: string;
    readonly result: "passed" | "failed";
    readonly reason: string;
    readonly versions: readonly string[];
  } | null;
  /** Version live now for this provider. `null` when nothing is installed yet. */
  readonly liveVersion: string | null;
}

export interface CliVersionCheckPorts {
  readonly getState: (provider: ProviderKind) => Promise<VersionCheckState | null>;
  readonly runLiveCheck: (provider: ProviderKind) => Promise<LiveCheckResult>;
  readonly promote: (
    provider: ProviderKind
  ) => Promise<
    { readonly state: "promoted" } | { readonly state: "error"; readonly message: string }
  >;
  readonly recordCheck: (
    provider: ProviderKind,
    check: {
      readonly at: string;
      readonly result: "passed" | "failed";
      readonly reason: string;
      readonly versions: readonly string[];
    }
  ) => Promise<void>;
  /** Called once per failed check. Dedupe by toolset, version and day lives behind this port. */
  readonly raiseFailure?: (
    provider: ProviderKind,
    versions: readonly string[],
    reason: string
  ) => Promise<void>;
  readonly now?: () => Date;
}

export type VersionCheckOutcome =
  | { readonly status: "no-candidate" }
  | { readonly status: "skipped-recent-failure" }
  | { readonly status: "runner-unavailable" }
  | { readonly status: "promoted"; readonly firstInstall: boolean }
  | { readonly status: "held-back"; readonly reason: string };

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function sameVersions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Check one provider's staged candidate. A failed candidate is retried once a day, or at once
 * when `force` is set (the admin's Retry). Never throws.
 */
export async function runCliVersionCheck(
  provider: ProviderKind,
  ports: CliVersionCheckPorts,
  opts: { readonly force?: boolean } = {}
): Promise<VersionCheckOutcome> {
  const now = ports.now ?? (() => new Date());
  try {
    const state = await ports.getState(provider);
    if (!state) return { status: "runner-unavailable" };
    if (state.candidate.length === 0) return { status: "no-candidate" };
    const versions = state.candidate.map((c) => c.version);

    const last = state.lastCheck;
    if (
      !opts.force &&
      last?.result === "failed" &&
      sameVersions(last.versions, versions) &&
      now().getTime() - Date.parse(last.at) < RETRY_AFTER_MS
    ) {
      return { status: "skipped-recent-failure" };
    }

    const record = (result: "passed" | "failed", reason: string) =>
      ports.recordCheck(provider, { at: now().toISOString(), result, reason, versions });
    const fail = async (reason: string): Promise<VersionCheckOutcome> => {
      await record("failed", reason);
      await ports.raiseFailure?.(provider, versions, reason).catch(() => undefined);
      return { status: "held-back", reason };
    };

    // With nothing live there is nothing to fall back to, so the candidate goes live first.
    // A failed check still alerts.
    const firstInstall = state.liveVersion === null;
    if (firstInstall) {
      const promoted = await ports.promote(provider);
      if (promoted.state === "error") return fail("promote_failed");
    }

    const live = await ports.runLiveCheck(provider);
    if (!live.passed) return fail(live.reason);

    if (!firstInstall) {
      const promoted = await ports.promote(provider);
      if (promoted.state === "error") return fail("promote_failed");
    }
    await record("passed", "ok");
    return { status: "promoted", firstInstall };
  } catch {
    return { status: "runner-unavailable" };
  }
}
