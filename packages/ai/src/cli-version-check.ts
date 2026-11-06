import type { ProviderKind } from "./cli-availability.js";

/**
 * #2689 slice 4: the version check. For Codex it runs the live check against a staged candidate
 * and either promotes it or holds it back. For Claude the update always goes live first and the
 * check runs afterwards in the background (#3689). Every collaborator is injected. The outcome comes from
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
  /**
   * Claude only. Called when the background check after a promotion fails, throws or times out.
   * The update stays live either way.
   */
  readonly raisePostPromoteFailure?: (
    provider: ProviderKind,
    versions: readonly string[],
    reason: string
  ) => Promise<void>;
  /** Time limit for the background check. */
  readonly postPromoteTimeoutMs?: number;
  readonly now?: () => Date;
}

/** Providers whose updates always go live before their check runs. */
const PROMOTE_FIRST_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["anthropic"]);

const POST_PROMOTE_TIMEOUT_MS = 120_000;

export type VersionCheckOutcome =
  | { readonly status: "no-candidate" }
  | { readonly status: "skipped-recent-failure" }
  | { readonly status: "runner-unavailable" }
  | {
      readonly status: "promoted";
      readonly firstInstall: boolean;
      /** Claude only. Settles when the background check is done. Never rejects. */
      readonly backgroundCheck?: Promise<void>;
    }
  | { readonly status: "held-back"; readonly reason: string };

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function sameVersions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function runBackgroundCheck(
  provider: ProviderKind,
  ports: CliVersionCheckPorts,
  versions: readonly string[],
  record: (result: "passed" | "failed", reason: string) => Promise<void>
): Promise<void> {
  const limitMs = ports.postPromoteTimeoutMs ?? POST_PROMOTE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const live = await Promise.race([
      ports.runLiveCheck(provider),
      new Promise<LiveCheckResult>((resolve) => {
        timer = setTimeout(() => resolve({ passed: false, reason: "timeout" }), limitMs);
      })
    ]);
    if (live.passed) {
      await record("passed", "ok");
      return;
    }
    await record("failed", live.reason);
    await ports.raisePostPromoteFailure?.(provider, versions, live.reason);
  } catch {
    await record("failed", "structured_call_failed").catch(() => undefined);
    await ports
      .raisePostPromoteFailure?.(provider, versions, "structured_call_failed")
      .catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    // The cooldown protects Codex's held-back candidate. Claude is never held back.
    if (
      !opts.force &&
      !PROMOTE_FIRST_PROVIDERS.has(provider) &&
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

    const firstInstall = state.liveVersion === null;

    // Claude: first install and upgrade behave the same. The update goes live, then the check
    // runs off to the side. Its result can alert but never undoes or delays the promotion.
    if (PROMOTE_FIRST_PROVIDERS.has(provider)) {
      const promoted = await ports.promote(provider);
      if (promoted.state === "error") return fail("promote_failed");
      const backgroundCheck = runBackgroundCheck(provider, ports, versions, record);
      return { status: "promoted", firstInstall, backgroundCheck };
    }

    // With nothing live there is nothing to fall back to, so the candidate goes live first.
    // A failed check still alerts.
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
