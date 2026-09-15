import { resolveMossEnv, type CalendarEvent, type DataContextDb } from "@moss/db";

import type { ConnectorAccountSafeRow } from "../repository.js";
import type { GoogleCalendarEvent } from "../google-api-client.js";
import {
  featureGrantsPrefKey,
  isFeatureGranted,
  resolveEffectiveGrants
} from "../feature-grants.js";
import { pickLatestSyncAt } from "../freshness.js";
import type { SyncLogger } from "../sync-jobs.js";
import {
  classifyLiveReadFailure,
  type CalendarContextFlag,
  type CalendarContextItem,
  type CalendarContextResult,
  type DegradedReason,
  type ListCalendarContextInput,
  type SourceAccountMeta,
  type SourceContextAccountResult,
  type SourceContextGap
} from "./types.js";

export const CALENDAR_DEFAULT_LOOKAHEAD_MS = 48 * 60 * 60 * 1000;
export const CALENDAR_DEFAULT_LIMIT = 50;
export const CALENDAR_MAX_LIMIT = 200;

const DEFAULT_TIMEZONE = resolveMossEnv(process.env, "JARVIS_DEFAULT_TZ") ?? "America/New_York";
const EARLY_LOCAL_HOUR = 9;
const LATE_LOCAL_HOUR = 18;

/**
 * Credential access is injected as a RESOLVER (not cipher + secret rows), mirroring
 * EmailSourceContextDeps: the live-read logic never handles encrypted material itself.
 */
export interface CalendarSourceContextDeps {
  readonly connectorsRepository: {
    listAccounts(scopedDb: DataContextDb): Promise<ConnectorAccountSafeRow[]>;
  };
  readonly preferencesRepository: {
    get(scopedDb: DataContextDb, key: string): Promise<unknown>;
  };
  /** Throws when the Google account cannot produce a token (missing/undecryptable/refused). */
  readonly resolveGoogleCredential: (
    scopedDb: DataContextDb,
    opts?: { force?: boolean }
  ) => Promise<string>;
  readonly googleClient: {
    listCalendarEvents(input: {
      accessToken: string;
      calendarId?: string;
      timeMin: string;
      timeMax: string;
      maxPages?: number;
    }): Promise<GoogleCalendarEvent[]>;
  };
  readonly calendarRepository: {
    listVisible(
      scopedDb: DataContextDb,
      options?: { startsAfter?: Date; startsBefore?: Date; endsAfter?: Date }
    ): Promise<CalendarEvent[]>;
  };
  readonly now?: () => Date;
  readonly timeZone?: string;
  readonly logger?: SyncLogger;
}

interface FlaggableItem {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly attendeeCount: number;
}

function localHour(iso: string, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23"
  }).format(new Date(iso));
  const hour = Number.parseInt(formatted, 10);
  return Number.isNaN(hour) ? 12 : hour;
}

function overlaps(a: FlaggableItem, b: FlaggableItem): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

export function classifyCalendarFlags(
  items: readonly FlaggableItem[],
  timeZone: string
): CalendarContextFlag[][] {
  return items.map((item, index) => {
    const flags: CalendarContextFlag[] = [];
    if (
      !item.allDay &&
      items.some(
        (other, otherIndex) => otherIndex !== index && !other.allDay && overlaps(item, other)
      )
    ) {
      flags.push("conflict");
    }
    if (!item.allDay) {
      const hour = localHour(item.startsAt, timeZone);
      if (hour < EARLY_LOCAL_HOUR) flags.push("early");
      if (hour >= LATE_LOCAL_HOUR) flags.push("late");
    }
    if (item.location !== null && item.location.trim().length > 0) flags.push("has_location");
    if (item.attendeeCount >= 2) flags.push("prep_attendees");
    return flags;
  });
}

function accountMeta(row: ConnectorAccountSafeRow): SourceAccountMeta {
  return {
    connectorAccountId: row.id,
    providerId: row.provider_id,
    providerLabel: row.provider_display_name
  };
}

interface MappedInstants {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
}

/** Same rules as sync-jobs mapEventInstants: dateTime pair, else date pair as all-day, else skip. */
function mapInstants(event: GoogleCalendarEvent): MappedInstants | null {
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

interface WindowBounds {
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

/** Routine noise: an all-day banner spanning the whole window with nothing to act on. */
function isRoutineAllDay(item: Omit<CalendarContextItem, "flags">, window: WindowBounds): boolean {
  return (
    item.allDay &&
    item.startsAt <= window.windowStart.toISOString() &&
    item.endsAt >= window.windowEnd.toISOString() &&
    (item.location === null || item.location.trim().length === 0) &&
    item.attendeeCount === 0
  );
}

type UnflaggedItem = Omit<CalendarContextItem, "flags">;

function inWindow(item: UnflaggedItem, now: Date, window: WindowBounds): boolean {
  if (item.endsAt < now.toISOString()) return false;
  if (item.startsAt >= window.windowEnd.toISOString()) return false;
  return !isRoutineAllDay(item, window);
}

function liveItem(
  event: GoogleCalendarEvent,
  instants: MappedInstants,
  meta: SourceAccountMeta
): UnflaggedItem {
  return {
    eventKey: event.id,
    account: meta,
    title: event.summary ?? "(no title)",
    startsAt: instants.startsAt,
    endsAt: instants.endsAt,
    allDay: instants.allDay,
    location: event.location ?? null,
    attendeeCount: event.attendees?.length ?? 0,
    source: "live",
    degradedReason: null
  };
}

function attendeeCountFromMetadata(row: CalendarEvent): number {
  const metadata = row.external_metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const count = (metadata as Record<string, unknown>).attendeeCount;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) return count;
  }
  return 0;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isMidnightUtc(iso: string): boolean {
  return iso.endsWith("T00:00:00.000Z");
}

function cacheItem(
  row: CalendarEvent,
  meta: SourceAccountMeta,
  degradedReason: DegradedReason
): UnflaggedItem {
  const startsAt = toIso(row.starts_at);
  const endsAt = toIso(row.ends_at);
  return {
    eventKey: row.external_id,
    account: meta,
    title: row.title,
    startsAt,
    endsAt,
    // Cached rows carry no all-day column; sync stores all-day instants at exact UTC midnight.
    allDay: isMidnightUtc(startsAt) && isMidnightUtc(endsAt),
    location: row.location,
    attendeeCount: attendeeCountFromMetadata(row),
    source: "cache",
    degradedReason
  };
}

export async function listCalendarContext(
  scopedDb: DataContextDb,
  deps: CalendarSourceContextDeps,
  input: ListCalendarContextInput
): Promise<CalendarContextResult> {
  const now = deps.now?.() ?? new Date();
  const timeZone = deps.timeZone ?? DEFAULT_TIMEZONE;
  const windowStart = input.windowStart ? new Date(input.windowStart) : now;
  const windowEnd = input.windowEnd
    ? new Date(input.windowEnd)
    : new Date(windowStart.getTime() + CALENDAR_DEFAULT_LOOKAHEAD_MS);
  const window: WindowBounds = { windowStart, windowEnd };
  const limit = Math.max(1, Math.min(input.limit ?? CALENDAR_DEFAULT_LIMIT, CALENDAR_MAX_LIMIT));

  const allAccounts = await deps.connectorsRepository.listAccounts(scopedDb);
  const calendarCapable = allAccounts.filter(
    (account) => resolveEffectiveGrants(account.scopes, null).calendar
  );
  if (calendarCapable.length === 0) {
    return { items: [], accounts: [], gaps: [], truncated: false, asOf: null };
  }

  const unflagged: UnflaggedItem[] = [];
  const accounts: SourceContextAccountResult[] = [];
  const gaps: SourceContextGap[] = [];
  let cachedRows: CalendarEvent[] | null = null;
  // A cached event that started before the window but is still running when the window opens
  // is still a real commitment inside it — bound by when it ENDS relative to the window start,
  // not when it started.
  const loadCache = async (): Promise<CalendarEvent[]> => {
    cachedRows ??= await deps.calendarRepository.listVisible(scopedDb, {
      endsAfter: windowStart,
      startsBefore: windowEnd
    });
    return cachedRows;
  };

  for (const account of calendarCapable) {
    const meta = accountMeta(account);

    if (account.status === "revoked") {
      gaps.push({ account: meta, reason: "connector_revoked" });
      continue;
    }
    const stored = await deps.preferencesRepository.get(scopedDb, featureGrantsPrefKey(account.id));
    if (!isFeatureGranted(stored, "calendar")) {
      gaps.push({ account: meta, reason: "feature_grant_disabled" });
      continue;
    }
    if (account.status !== "active") {
      gaps.push({ account: meta, reason: "auth_error" });
      continue;
    }
    if (account.provider_type !== "google") {
      gaps.push({ account: meta, reason: "unsupported_provider" });
      continue;
    }

    // Credential resolution failure = broken auth → gap, never silent cache (spec §4).
    let token: string;
    try {
      token = await deps.resolveGoogleCredential(scopedDb);
    } catch {
      gaps.push({ account: meta, reason: "auth_error" });
      continue;
    }

    const attempt = async (accessToken: string) => {
      const events = await deps.googleClient.listCalendarEvents({
        accessToken,
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString()
      });
      const mapped: UnflaggedItem[] = [];
      for (const event of events) {
        if (event.status === "cancelled") continue;
        const instants = mapInstants(event);
        if (!instants) continue;
        const item = liveItem(event, instants, meta);
        if (inWindow(item, now, window)) mapped.push(item);
      }
      return mapped;
    };

    try {
      let accountItems: UnflaggedItem[];
      try {
        accountItems = await attempt(token);
      } catch (error) {
        const classified = classifyLiveReadFailure(error);
        if (classified.kind !== "auth") throw error;
        // One forced token refresh, then the auth gap stands (spec §4).
        const freshToken = await deps.resolveGoogleCredential(scopedDb, { force: true });
        accountItems = await attempt(freshToken);
      }
      unflagged.push(...accountItems);
      // Live means this account was just observed, right now — that beats any past sync log.
      accounts.push({
        account: meta,
        source: "live",
        degradedReason: null,
        asOf: now.toISOString()
      });
    } catch (error) {
      const classified = classifyLiveReadFailure(error);
      if (classified.kind === "auth") {
        gaps.push({ account: meta, reason: "auth_error" });
        continue;
      }
      deps.logger?.warn(
        { stage: "source-context-calendar", accountId: account.id, name: (error as Error)?.name },
        "live calendar read failed; serving cache fallback"
      );
      const fallback = (await loadCache())
        .filter((row) => row.connector_account_id === account.id)
        .map((row) => cacheItem(row, meta, classified.degradedReason))
        .filter((item) => inWindow(item, now, window));
      unflagged.push(...fallback);
      // This account's own last completed sync — not another account's, which could be newer
      // and would wrongly make this account's stale data look current.
      const accountAsOf = pickLatestSyncAt([account], "calendar")?.toISOString() ?? null;
      accounts.push({
        account: meta,
        source: "cache",
        degradedReason: classified.degradedReason,
        asOf: accountAsOf
      });
    }
  }

  unflagged.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
  const capped = unflagged.slice(0, limit);
  const flags = classifyCalendarFlags(capped, timeZone);
  const items: CalendarContextItem[] = capped.map((item, index) => ({
    ...item,
    flags: flags[index] ?? []
  }));
  // The result's overall freshness can only be as good as its least fresh contributing account
  // (any unknown account freshness makes the whole result's freshness unknown too) — never the
  // most recent one, which would let one fresh account mask another account's stale data.
  const accountAsOfs = accounts.map((a) => a.asOf ?? null);
  const asOf: string | null =
    accountAsOfs.length === 0 || accountAsOfs.some((value) => value === null)
      ? null
      : accountAsOfs.reduce<string>(
          (min, value) => (value! < min ? value! : min),
          accountAsOfs[0]!
        );
  return { items, accounts, gaps, truncated: capped.length < unflagged.length, asOf };
}
