/**
 * #2031 (epic #1586, piece 2): the seam a module uses to publish its own small, safe diagnostic
 * view, plus the generic aggregator that runs every registered provider for one actor.
 *
 * This lives in its own file for two reasons: index.ts is already close to the 1000-line file-size
 * gate, and widening the SDK's public surface should be visible in review as a named export rather
 * than hidden inside a barrel. Like every other seam here it imports nothing from `node:*` — the
 * barrel must stay browser-safe (see the note at the top of index.ts).
 */

/**
 * One module's answer to "how is your part of the system doing, for this actor?".
 *
 * Deliberately tiny. A provider reports STATUS about its own domain — never the domain's content.
 * The news provider reports how stale the feed is; it must never carry a headline.
 */
export interface ModuleDiagnosticObservation {
  /** Coarse area this observation is about, e.g. "news". */
  readonly domain: string;
  /** Stable identifier for this particular view, e.g. "news.refresh". */
  readonly providerId: string;
  /** ISO 8601 instant the observation was taken. */
  readonly observedAt: string;
  readonly status: "ok" | "degraded" | "failed" | "unknown";
  /** One plain sentence, hard-capped — see MODULE_DIAGNOSTIC_LIMITS.summaryMaxLength. */
  readonly summary: string;
  /**
   * Identifier of a remediation action the platform already recognises, e.g. "news.refreshNews".
   * A LABEL only: nothing in this seam can execute anything. Whoever surfaces it is responsible
   * for its own permission check.
   */
  readonly remediationActionId?: string;
  /**
   * Bounded structured facts, so a consumer can cite a timestamp or a count without going and
   * reading the module's own tables (which is the module-isolation problem this seam exists to
   * prevent). Scalars only, capped in count and length — see MODULE_DIAGNOSTIC_LIMITS. No nested
   * objects, no arrays, and never free text that came from outside the platform.
   */
  readonly facts?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * A module diagnostic provider. `scopedDb` is a DataContextDb supplied under withDataContext; it
 * is typed `unknown` to avoid a module-sdk -> db dependency (the owning module narrows it via
 * assertDataContextDb, exactly like FocusSignalProvider and ToolExecute). Returns null = nothing
 * to report for this actor.
 */
export interface ModuleDiagnosticProvider {
  readonly domain: string;
  readonly providerId: string;
  observe(
    scopedDb: unknown,
    ctx: { readonly actorUserId: string; readonly requestId: string }
  ): Promise<ModuleDiagnosticObservation | null>;
}

export interface RegisteredModuleDiagnosticProvider {
  readonly moduleId: string;
  readonly provider: ModuleDiagnosticProvider;
}

/**
 * Runs a single provider's work inside a FRESH, per-provider data context. The composition root
 * supplies this (wrapping `DataContextRunner.withDataContext`) so module-sdk stays free of a
 * `@moss/db` dependency. Each provider MUST get its own context — see aggregateModuleDiagnostics.
 */
export type ModuleDiagnosticContextRunner = <T>(
  work: (scopedDb: unknown) => Promise<T>,
  ctx: { readonly actorUserId: string; readonly requestId: string }
) => Promise<T>;

export interface ModuleDiagnosticAggregateOptions {
  /**
   * Called when a provider throws, times out, or returns a malformed value. Receives ONLY the
   * contributing moduleId and the error's name — never the message, the stack, or any payload, so
   * an outage is observable without leaking whatever the provider was looking at.
   */
  readonly onProviderError?: (moduleId: string, errorName: string) => void;
}

/**
 * Every bound the aggregator enforces, in one exported object so a test can read them rather than
 * restate them.
 *
 * The 2000ms deadline is deliberately eight times the focus-signal aggregator's 250ms: focus runs
 * on a page-render path where late is useless, whereas diagnostics run on a conversation path
 * where a slow honest answer beats a fast empty one.
 */
export const MODULE_DIAGNOSTIC_LIMITS = {
  providerTimeoutMs: 2000,
  summaryMaxLength: 300,
  maxFactKeys: 12,
  factValueMaxLength: 120
} as const;

const VALID_STATUSES: ReadonlySet<string> = new Set(["ok", "degraded", "failed", "unknown"]);

const MALFORMED = "MalformedModuleDiagnosticObservation";

function factsAreWithinCaps(facts: unknown): boolean {
  if (facts === undefined) return true;
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) return false;
  const entries = Object.entries(facts as Record<string, unknown>);
  if (entries.length > MODULE_DIAGNOSTIC_LIMITS.maxFactKeys) return false;
  return entries.every(([, value]) => {
    if (value === null) return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return true;
    if (typeof value === "string")
      return value.length <= MODULE_DIAGNOSTIC_LIMITS.factValueMaxLength;
    // Anything else (object, array, function, undefined, symbol) is out of contract.
    return false;
  });
}

/**
 * Validates the whole observation. Note that a breach DROPS the observation rather than trimming
 * it: a truncated summary or a doctored fact set reads as complete to whoever consumes it, which
 * is worse than an honest absence.
 */
function isWellFormed(value: unknown): value is ModuleDiagnosticObservation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.domain !== "string" || candidate.domain.length === 0) return false;
  if (typeof candidate.providerId !== "string" || candidate.providerId.length === 0) return false;
  if (typeof candidate.observedAt !== "string" || Number.isNaN(Date.parse(candidate.observedAt))) {
    return false;
  }
  if (typeof candidate.status !== "string" || !VALID_STATUSES.has(candidate.status)) return false;
  if (
    typeof candidate.summary !== "string" ||
    candidate.summary.length === 0 ||
    candidate.summary.length > MODULE_DIAGNOSTIC_LIMITS.summaryMaxLength
  ) {
    return false;
  }
  if (
    candidate.remediationActionId !== undefined &&
    typeof candidate.remediationActionId !== "string"
  ) {
    return false;
  }
  return factsAreWithinCaps(candidate.facts);
}

/** Re-project onto exactly the contract's fields, so a provider cannot smuggle an extra one. */
function project(observation: ModuleDiagnosticObservation): ModuleDiagnosticObservation {
  return {
    domain: observation.domain,
    providerId: observation.providerId,
    observedAt: observation.observedAt,
    status: observation.status,
    summary: observation.summary,
    ...(observation.remediationActionId === undefined
      ? {}
      : { remediationActionId: observation.remediationActionId }),
    ...(observation.facts === undefined ? {} : { facts: { ...observation.facts } })
  };
}

/**
 * Run every registered provider for an actor and collect the well-formed observations. Generic and
 * uniform: it knows nothing about any specific module. A provider that throws, stalls or returns a
 * malformed value contributes nothing (fail soft — one module must never break the report), but the
 * drop is reported via `onProviderError` so outages are not silent.
 *
 * CONCURRENCY/ISOLATION: each provider runs in its OWN data context via `runInContext` — a fresh
 * withDataContext, so a fresh transaction on a fresh connection. This is load-bearing, not
 * cosmetic, and is the same reasoning as aggregateFocusSignals: one shared Kysely transaction is
 * ONE pg client, so "concurrent" provider queries would serialize on it, and any provider whose
 * query aborts the transaction (Postgres 25P02) would poison every other provider on that same
 * connection — turning one module's failure into a total diagnostics outage and defeating the
 * fail-soft guarantee above.
 */
export async function aggregateModuleDiagnostics(
  providers: readonly RegisteredModuleDiagnosticProvider[],
  runInContext: ModuleDiagnosticContextRunner,
  ctx: { readonly actorUserId: string; readonly requestId: string },
  options: ModuleDiagnosticAggregateOptions = {}
): Promise<ModuleDiagnosticObservation[]> {
  const results = await Promise.all(
    providers.map(async ({ moduleId, provider }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(
              `ModuleDiagnosticProvider timed out after ${MODULE_DIAGNOSTIC_LIMITS.providerTimeoutMs}ms`
            );
            error.name = "ProviderTimeout";
            reject(error);
          }, MODULE_DIAGNOSTIC_LIMITS.providerTimeoutMs);
        });
        const observation = await Promise.race([
          runInContext((scopedDb) => provider.observe(scopedDb, ctx), ctx),
          deadline
        ]);
        if (observation === null || observation === undefined) return null;
        if (!isWellFormed(observation)) {
          options.onProviderError?.(moduleId, MALFORMED);
          return null;
        }
        return project(observation);
      } catch (error) {
        options.onProviderError?.(moduleId, error instanceof Error ? error.name : "UnknownError");
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })
  );
  return results.filter((entry): entry is ModuleDiagnosticObservation => entry !== null);
}
