import type { AiCliToolsDto } from "@moss/shared";

import type { ProviderKind } from "./cli-availability.js";
import type { CliToolsRefreshOutcome } from "./cli-tools-refresh.js";

/**
 * #2689 slice 4: what the provider card shows about a tool update. The state comes from stored
 * records (the runner's state file) and a small in-process status. The model's words are never
 * read.
 */

/** Plain words for each fixed reason code. Raw tool output never reaches this table. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  tool_call_missing: "couldn't use Moss's tools in a test chat",
  structured_call_failed: "didn't return usable answers to a background request",
  timeout: "didn't answer in time",
  promote_failed: "couldn't be installed",
  check_unavailable: "couldn't be tested because no admin is signed in to this provider"
};

export function cliToolReasonText(code: string): string {
  return REASON_TEXT[code] ?? "failed its check";
}

/** Providers whose staged candidate gets a live check. Others never leave "staged". */
const CHECKED_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai-compatible"]);

/** Days without a reachable manifest before the card says it cannot check. */
export const CANNOT_CHECK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** What the runner reports about one provider's staged candidate. */
export interface CliToolsRunnerUpdate {
  readonly candidateVersion: string | null;
  readonly lastCheck: {
    readonly at: string;
    readonly result: "passed" | "failed";
    readonly reason: string;
  } | null;
}

export interface CliToolsStatusSnapshot {
  readonly checking: ReadonlySet<string>;
  readonly needsNewerMoss: Readonly<Record<string, string>>;
  readonly cannotCheck: boolean;
}

/** In-process status for the update pass. One per API process. */
export class CliToolsStatusStore {
  private readonly running = new Set<string>();
  private needsNewerMoss: Record<string, string> = {};
  private failingSince: number | null = null;

  setChecking(provider: string, on: boolean): void {
    if (on) this.running.add(provider);
    else this.running.delete(provider);
  }

  /** Reads a refresh outcome. A runner that is down says nothing about the manifest. */
  recordRefresh(outcome: CliToolsRefreshOutcome, now: number = Date.now()): void {
    if (outcome.status === "runner-unavailable") return;
    if (outcome.status === "fetch-failed") {
      this.failingSince ??= now;
      return;
    }
    this.failingSince = null;
    if (outcome.status === "ok") this.needsNewerMoss = { ...(outcome.needsNewerMoss ?? {}) };
  }

  snapshot(now: number = Date.now()): CliToolsStatusSnapshot {
    return {
      checking: new Set(this.running),
      needsNewerMoss: { ...this.needsNewerMoss },
      cannotCheck: this.failingSince !== null && now - this.failingSince >= CANNOT_CHECK_AFTER_MS
    };
  }
}

let retryHandler: ((provider: ProviderKind) => Promise<void>) | undefined;

/** Registers what Retry does. The composition root sets it to "refresh and check now". */
export function setCliToolsRetry(
  handler: ((provider: ProviderKind) => Promise<void>) | undefined
): void {
  retryHandler = handler;
}

/** Starts a forced refresh and check for one provider. False when no runner is wired. */
export function requestCliToolsRetry(provider: ProviderKind): boolean {
  if (!retryHandler) return false;
  cliToolsStatus.setChecking(provider, true);
  void retryHandler(provider)
    .catch(() => undefined)
    .finally(() => cliToolsStatus.setChecking(provider, false));
  return true;
}

/** The one store the update pass writes and the provider routes read. */
export const cliToolsStatus = new CliToolsStatusStore();

/**
 * The card block for one provider. Order of precedence: a check in progress, a held back
 * candidate, a toolset waiting for a newer Moss, a manifest that cannot be reached, then plain.
 */
export function deriveCliToolsDto(input: {
  readonly provider: ProviderKind;
  readonly version: string | null;
  readonly update: CliToolsRunnerUpdate | undefined;
  readonly status: CliToolsStatusSnapshot;
}): AiCliToolsDto {
  const { provider, version, update, status } = input;
  const base: AiCliToolsDto =
    version === null ? { version, state: "not_installed" } : { version, state: "current" };
  const candidate = update?.candidateVersion ?? undefined;
  const last = update?.lastCheck ?? null;
  const lastCheckedAt = last ? { lastCheckedAt: last.at } : {};

  const awaitingCheck = candidate && !last && CHECKED_PROVIDERS.has(provider);
  if (status.checking.has(provider) || awaitingCheck) {
    return { ...base, state: "checking", ...(candidate ? { candidateVersion: candidate } : {}) };
  }
  if (candidate && last?.result === "failed") {
    return {
      ...base,
      state: "held_back",
      candidateVersion: candidate,
      ...lastCheckedAt,
      reason: cliToolReasonText(last.reason)
    };
  }
  const waiting = status.needsNewerMoss[provider];
  if (waiting) return { ...base, state: "needs_newer_moss", candidateVersion: waiting };
  if (status.cannotCheck) return { ...base, state: "cannot_check" };
  return { ...base, ...(last ? lastCheckedAt : {}) };
}
