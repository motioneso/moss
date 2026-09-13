// Production adapters for reserved-apply execution: the write-access gate and
// the live-first calendar facts source. Internal only — no route or worker
// wiring. T04C owns the authenticated surface and composition binding.
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { CalendarRepository } from "@moss/calendar";
import {
  CALENDAR_SIGNAL_BLOCK_TIME_KEY,
  CALENDAR_SIGNAL_SUGGEST_TIME_BLOCKS_KEY,
  CALENDAR_TIME_BLOCK_MODE_KEY,
  type ApplyExecutionAccessGate,
  type ApplyExecutionFacts,
  type ApplyBusyInterval
} from "@moss/calendar";
import {
  classifyLiveReadFailure,
  featureGrantsPrefKey,
  isFeatureGranted,
  pickLatestSyncAt,
  resolveEffectiveGrants,
  type ConnectorsRepository,
  type GoogleApiClient,
  type GoogleCalendarEvent,
  type GoogleConnectionService
} from "@moss/connectors";
import { parseCalendarAutomationMode } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

const WRITEBACK_POLICY_KEY = "assistant.action_policy.v1.calendar.calendar_writeback";

export interface ApplyAccessGateDeps {
  readonly connectorsRepository: Pick<ConnectorsRepository, "getCalendarWriteScopeState">;
  readonly preferencesRepository?: Pick<PreferencesRepository, "get">;
}

// Every check reads current state: an active writable account, Calendar write
// scope, the Calendar feature grant, an allowing time-block mode, and a stored
// writeback tier. A concrete reservation satisfies ask_each_time; off, revoked
// access, and missing, malformed, disabled or unrecognized policy deny. A
// missing policy row never falls back to a default.
export function buildApplyAccessGate(deps: ApplyAccessGateDeps): ApplyExecutionAccessGate {
  return {
    async checkAccess(
      scopedDb: DataContextDb
    ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
      const prefs = deps.preferencesRepository ?? new PreferencesRepository();
      const scope = await deps.connectorsRepository.getCalendarWriteScopeState(scopedDb);
      if (!scope?.hasScope) {
        return { ok: false, reason: "calendar write scope is not granted" };
      }
      const grants = await prefs.get(scopedDb, featureGrantsPrefKey(scope.accountId));
      if (!isFeatureGranted(grants, "calendar")) {
        return { ok: false, reason: "calendar automation is disabled for this account" };
      }
      const [storedMode, blockTime, suggestTimeBlocks] = await Promise.all([
        prefs.get(scopedDb, CALENDAR_TIME_BLOCK_MODE_KEY),
        prefs.get(scopedDb, CALENDAR_SIGNAL_BLOCK_TIME_KEY),
        prefs.get(scopedDb, CALENDAR_SIGNAL_SUGGEST_TIME_BLOCKS_KEY)
      ]);
      const mode = parseCalendarAutomationMode(
        storedMode,
        blockTime === true ? "auto" : suggestTimeBlocks === false ? "off" : "suggest"
      );
      if (mode === "off") {
        return { ok: false, reason: "time blocking is off" };
      }
      const storedTier = await prefs.get(scopedDb, WRITEBACK_POLICY_KEY);
      if (storedTier === "ask_each_time" || storedTier === "trusted_auto") {
        return { ok: true };
      }
      if (typeof storedTier !== "string") {
        return { ok: false, reason: "calendar writeback policy is not set" };
      }
      return {
        ok: false,
        reason: `calendar writeback policy forbids automatic writes (tier: ${storedTier})`
      };
    }
  };
}

export interface ApplyFactsAdapterDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly connectorsRepository: Pick<ConnectorsRepository, "listAccounts">;
  readonly preferencesRepository?: Pick<PreferencesRepository, "get">;
  readonly googleService: Pick<
    GoogleConnectionService,
    "readActiveCredential" | "refreshCredential" | "storeRefreshedCredential"
  >;
  readonly googleClient: Pick<GoogleApiClient, "listCalendarEvents">;
  readonly calendarRepository?: Pick<CalendarRepository, "listVisible">;
  readonly now?: () => Date;
}

const FACTS_LIMIT = 200;

interface StagedReads {
  readonly accounts: ReadonlyArray<{
    readonly id: string;
    readonly providerId: string;
    readonly providerLabel: string;
    readonly providerType: string;
    readonly status: string;
    readonly scopes: readonly string[];
    readonly lastSyncFinishedAt: Date | null;
    readonly grantStored: unknown;
  }>;
  readonly credential: {
    readonly accountId: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
    readonly grantedScopes: string[];
    readonly accessToken: string;
    readonly tokenExpiry: string;
  } | null;
}

interface FactsGap {
  readonly account: { readonly providerLabel: string };
  readonly reason: string;
}

interface UnflaggedFact {
  readonly eventKey: string;
  readonly accountLabel: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly source: "live" | "cache";
  readonly degradedReason: string | null;
  readonly asOf: string | null;
}

function mapFactInstants(event: GoogleCalendarEvent): {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
} | null {
  const start = event.start ?? {};
  const end = event.end ?? {};
  if (start.dateTime && end.dateTime) {
    return {
      startsAt: new Date(start.dateTime).toISOString(),
      endsAt: new Date(end.dateTime).toISOString(),
      allDay: false
    };
  }
  if (start.date && end.date) {
    return {
      startsAt: `${start.date}T00:00:00.000Z`,
      endsAt: `${end.date}T00:00:00.000Z`,
      allDay: true
    };
  }
  return null;
}

function isRoutineAllDay(
  item: Pick<UnflaggedFact, "allDay" | "startsAt" | "endsAt">,
  windowStart: string,
  windowEnd: string
): boolean {
  return item.allDay && item.startsAt <= windowStart && item.endsAt >= windowEnd;
}

// Live-first facts with staged transactions. Database work happens in short
// read or persist transactions only: account, grant and credential reads up
// front, guarded credential persistence and cache-fallback reads later. Token
// refresh and every Google read run with no transaction open, so the
// execution service observes zero open transactions on every provider call.
// Mapping rules mirror the shared live-first reader: full account coverage,
// timed-event filtering, per-account gaps, truncation and freshness.
export function buildApplyFactsAdapter(deps: ApplyFactsAdapterDeps): {
  forAccess(access: AccessContext): ApplyExecutionFacts;
} {
  const prefs = deps.preferencesRepository ?? new PreferencesRepository();
  const now = deps.now ?? (() => new Date());
  return {
    forAccess(access: AccessContext): ApplyExecutionFacts {
      return {
        async readAvailability(window: { readonly start: string; readonly end: string }) {
          const staged: StagedReads = await deps.dataContext.withDataContext(
            access,
            async (scopedDb) => {
              const rows = await deps.connectorsRepository.listAccounts(scopedDb);
              const accounts = await Promise.all(
                rows.map(async (row) => ({
                  id: row.id,
                  providerId: row.provider_id,
                  providerLabel: row.provider_display_name,
                  providerType: row.provider_type,
                  status: row.status,
                  scopes: row.scopes,
                  lastSyncFinishedAt: row.last_sync_finished_at,
                  grantStored: await prefs.get(scopedDb, featureGrantsPrefKey(row.id))
                }))
              );
              const credential = await deps.googleService.readActiveCredential(scopedDb);
              return {
                accounts,
                credential: credential
                  ? {
                      accountId: credential.accountId,
                      clientId: credential.bundle.clientId,
                      clientSecret: credential.bundle.clientSecret,
                      refreshToken: credential.bundle.refreshToken,
                      grantedScopes: [...credential.bundle.grantedScopes],
                      accessToken: credential.bundle.accessToken,
                      tokenExpiry: credential.bundle.tokenExpiry
                    }
                  : null
              };
            }
          );

          const windowStart = new Date(window.start);
          const windowEnd = new Date(window.end);
          const current = now();
          const facts: UnflaggedFact[] = [];
          const accounts: { readonly source: "live" | "cache"; readonly asOf: string | null }[] =
            [];
          const gaps: FactsGap[] = [];

          const eligible = staged.accounts.filter(
            (account) => resolveEffectiveGrants(account.scopes, null).calendar
          );
          if (eligible.length === 0) {
            return { intervals: [], complete: false };
          }

          let accessToken: string | null = null;
          if (staged.credential) {
            accessToken = await ensureFactsToken(deps, access, staged.credential);
          }
          if (!staged.credential || accessToken === null) {
            for (const account of eligible) {
              gaps.push({
                account: { providerLabel: account.providerLabel },
                reason: "auth_error"
              });
            }
            return { intervals: [], complete: false };
          }

          for (const account of eligible) {
            if (account.status === "revoked") {
              gaps.push({
                account: { providerLabel: account.providerLabel },
                reason: "connector_revoked"
              });
              continue;
            }
            if (!isFeatureGranted(account.grantStored, "calendar")) {
              gaps.push({
                account: { providerLabel: account.providerLabel },
                reason: "feature_grant_disabled"
              });
              continue;
            }
            if (account.status !== "active") {
              gaps.push({
                account: { providerLabel: account.providerLabel },
                reason: "auth_error"
              });
              continue;
            }
            if (account.providerType !== "google") {
              gaps.push({
                account: { providerLabel: account.providerLabel },
                reason: "unsupported_provider"
              });
              continue;
            }

            const live = await readLiveAccount(
              deps,
              access,
              staged.credential,
              accessToken,
              account,
              windowStart,
              windowEnd
            );
            if (live.kind === "gap") {
              gaps.push({ account: { providerLabel: account.providerLabel }, reason: live.reason });
              continue;
            }
            if (live.kind === "fallback") {
              await readCacheFallback(
                deps,
                access,
                account,
                windowStart,
                windowEnd,
                current,
                live.degraded,
                facts,
                accounts
              );
              continue;
            }
            accessToken = live.accessToken;
            for (const event of live.events) {
              if (event.status === "cancelled") continue;
              const instants = mapFactInstants(event);
              if (!instants) continue;
              const item: UnflaggedFact = {
                eventKey: event.id,
                accountLabel: account.providerLabel,
                title: event.summary ?? "(no title)",
                startsAt: instants.startsAt,
                endsAt: instants.endsAt,
                allDay: instants.allDay,
                source: "live",
                degradedReason: null,
                asOf: current.toISOString()
              };
              if (item.endsAt < current.toISOString()) continue;
              if (item.startsAt >= windowEnd.toISOString()) continue;
              if (isRoutineAllDay(item, windowStart.toISOString(), windowEnd.toISOString())) {
                continue;
              }
              facts.push(item);
            }
            accounts.push({ source: "live", asOf: current.toISOString() });
          }

          facts.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
          const capped = facts.slice(0, FACTS_LIMIT);
          const truncated = capped.length < facts.length;
          const collected = accounts.map((entry) => entry.asOf);
          const asOf: string | null =
            collected.length === 0 || collected.some((value) => value === null)
              ? null
              : collected.reduce<string>(
                  (min, value) => (value! < min ? value! : min),
                  collected[0]!
                );
          const complete =
            accounts.length > 0 &&
            accounts.every((entry) => entry.source === "live") &&
            gaps.length === 0 &&
            !truncated &&
            asOf !== null;
          const intervals: ApplyBusyInterval[] = capped
            .filter((item) => !item.allDay)
            .map((item) => ({
              start: item.startsAt,
              end: item.endsAt,
              title: item.title,
              accountLabel: item.accountLabel,
              eventKey: item.eventKey
            }));
          return { intervals, complete };
        }
      };
    }
  };
}

// One account's live read at transaction depth zero: a single forced token
// refresh on auth failure, then the auth gap stands. Anything else transient
// falls back to the cache; only a verified miss-free live read returns events.
async function readLiveAccount(
  deps: ApplyFactsAdapterDeps,
  access: AccessContext,
  credential: StagedReads["credential"],
  accessToken: string,
  account: StagedReads["accounts"][number],
  windowStart: Date,
  windowEnd: Date
): Promise<
  | {
      readonly kind: "events";
      readonly events: GoogleCalendarEvent[];
      readonly accessToken: string;
    }
  | { readonly kind: "fallback"; readonly degraded: string | undefined }
  | { readonly kind: "gap"; readonly reason: string }
> {
  const read = (token: string) =>
    deps.googleClient.listCalendarEvents({
      accessToken: token,
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString()
    });
  try {
    return { kind: "events", events: await read(accessToken), accessToken };
  } catch (error) {
    const classified = classifyLiveReadFailure(error);
    if (classified.kind !== "auth") {
      return { kind: "fallback", degraded: classified.degradedReason };
    }
  }
  const fresh = credential ? await ensureFactsToken(deps, access, credential, true) : null;
  if (fresh === null) {
    return { kind: "gap", reason: "auth_error" };
  }
  try {
    return { kind: "events", events: await read(fresh), accessToken: fresh };
  } catch (retryError) {
    if (classifyLiveReadFailure(retryError).kind === "auth") {
      return { kind: "gap", reason: "auth_error" };
    }
    return { kind: "fallback", degraded: undefined };
  }
}

// Token refresh runs with no transaction open; the refreshed credential
// persists in a new short transaction only after confirming the same account
// is still active with the same refresh token. Null means authentication
// cannot proceed, and the caller records an auth gap instead of reading.
async function ensureFactsToken(
  deps: ApplyFactsAdapterDeps,
  access: AccessContext,
  reads: NonNullable<StagedReads["credential"]>,
  force = false
): Promise<string | null> {
  if (!force && new Date(reads.tokenExpiry).getTime() - Date.now() > 60_000) {
    return reads.accessToken;
  }
  let refreshed: { accessToken: string; tokenExpiry: string };
  try {
    refreshed = await deps.googleService.refreshCredential({
      clientId: reads.clientId,
      clientSecret: reads.clientSecret,
      refreshToken: reads.refreshToken
    });
  } catch {
    return null;
  }
  const stored = await deps.dataContext.withDataContext(access, (scopedDb) =>
    deps.googleService.storeRefreshedCredential(
      scopedDb,
      { accountId: reads.accountId, refreshToken: reads.refreshToken },
      {
        clientId: reads.clientId,
        clientSecret: reads.clientSecret,
        accessToken: refreshed.accessToken,
        tokenExpiry: refreshed.tokenExpiry,
        grantedScopes: reads.grantedScopes
      }
    )
  );
  if (!stored) return null;
  return refreshed.accessToken;
}

async function readCacheFallback(
  deps: ApplyFactsAdapterDeps,
  access: AccessContext,
  account: StagedReads["accounts"][number],
  windowStart: Date,
  windowEnd: Date,
  current: Date,
  degraded: string | undefined,
  facts: UnflaggedFact[],
  accounts: { readonly source: "live" | "cache"; readonly asOf: string | null }[]
): Promise<void> {
  if (!deps.calendarRepository) {
    accounts.push({ source: "cache", asOf: null });
    return;
  }
  const rows = await deps.dataContext.withDataContext(access, (scopedDb) =>
    deps.calendarRepository!.listVisible(scopedDb, {
      endsAfter: windowStart,
      startsBefore: windowEnd
    })
  );
  for (const row of rows) {
    if (row.connector_account_id !== account.id) continue;
    const startsAt = new Date(row.starts_at).toISOString();
    const endsAt = new Date(row.ends_at).toISOString();
    const allDay = startsAt.endsWith("T00:00:00.000Z") && endsAt.endsWith("T00:00:00.000Z");
    const item: UnflaggedFact = {
      eventKey: row.external_id,
      accountLabel: account.providerLabel,
      title: row.title,
      startsAt,
      endsAt,
      allDay,
      source: "cache",
      degradedReason: degraded ?? "provider_error",
      asOf:
        pickLatestSyncAt(
          [{ scopes: [...account.scopes], last_sync_finished_at: account.lastSyncFinishedAt }],
          "calendar"
        )?.toISOString() ?? null
    };
    if (item.endsAt < current.toISOString()) continue;
    if (item.startsAt >= windowEnd.toISOString()) continue;
    if (isRoutineAllDay(item, windowStart.toISOString(), windowEnd.toISOString())) continue;
    facts.push(item);
  }
  accounts.push({
    source: "cache",
    asOf:
      pickLatestSyncAt(
        [{ scopes: [...account.scopes], last_sync_finished_at: account.lastSyncFinishedAt }],
        "calendar"
      )?.toISOString() ?? null
  });
}
