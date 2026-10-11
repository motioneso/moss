import { createHash } from "node:crypto";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  ProactiveMonitorInput,
  ProactiveMonitorProvider,
  ProactiveMonitorResult,
  ProactiveMonitorSignal
} from "@moss/module-sdk";
import { formatLocaleDateTime, localDay } from "@moss/shared";

import { CalendarRepository } from "./repository.js";

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** URLs with credential-like query params — strip the whole URL to avoid leaking auth state. */
const AUTH_URL_PATTERN =
  /https?:\/\/\S*[?&](token|access_token|session|auth|api_key|apikey|secret|client_secret|code|refresh_token)\S*/gi;

/** Line patterns indicating a secret or credential assignment — redact. */
const CREDENTIAL_LINE_PATTERN =
  /^.*(password|passwd|api[_\s-]?key|secret[_\s-]?key|auth[_\s-]?token|session[_\s-]?token|bearer\s+\S{6,}|private[_\s-]?key|access[_\s-]?token)\s*[:=]\s*\S+.*$/gim;

function sanitizeSnippet(text: string): string {
  return text
    .replace(AUTH_URL_PATTERN, "[link removed]")
    .replace(/\bbearer\s+\S{6,}/gi, "[redacted]")
    .replace(CREDENTIAL_LINE_PATTERN, "[redacted]");
}

/** Events starting within this window are considered "soon". */
const SOON_HOURS = 24;

export const calendarMonitorProvider: ProactiveMonitorProvider = {
  source: "calendar",
  moduleId: "calendar",

  async collectSignals(
    scopedDb: unknown,
    input: ProactiveMonitorInput
  ): Promise<ProactiveMonitorResult> {
    assertDataContextDb(scopedDb as DataContextDb);
    const db = scopedDb as DataContextDb;
    const repo = new CalendarRepository();
    const now = new Date(input.now);
    const soonCutoff = new Date(now.getTime() + SOON_HOURS * 60 * 60 * 1000);

    const allEvents = await repo.listVisible(db);
    const upcoming = allEvents.filter((e) => {
      const starts = new Date(e.starts_at as unknown as string);
      return starts >= now && starts <= soonCutoff;
    });

    const signals: ProactiveMonitorSignal[] = [];

    // Dense schedule: 3+ events in next 24h, one card per owner-local day
    if (upcoming.length >= 3 && signals.length < input.maxSignals) {
      const today = localDay(now, input.locale.timezone);
      signals.push({
        source: "calendar",
        stableKey: `dense-schedule:${stableHash(today)}`,
        sourceRefHash: stableHash(`dense:${upcoming.length}:${today}`),
        signalType: "dense_schedule",
        title: "Dense schedule ahead",
        summary: `${upcoming.length} events in the next 24 hours`,
        occurredAt: input.now,
        priorityCandidate: {}
      });
    }

    // Individual events soon
    for (const event of upcoming) {
      if (signals.length >= input.maxSignals) break;
      const starts = new Date(event.starts_at as unknown as string);
      const hoursUntil = (starts.getTime() - now.getTime()) / (60 * 60 * 1000);
      const stableKey = `event-soon:${stableHash(event.external_id ?? event.id)}`;
      const signalType = hoursUntil <= 2 ? "prep_needed" : "event_changed_soon";

      signals.push({
        source: "calendar",
        stableKey,
        sourceRefHash: stableHash(event.external_id ?? event.id),
        signalType,
        title: sanitizeSnippet(event.title).slice(0, 200),
        summary:
          hoursUntil <= 2
            ? `Upcoming in ${Math.round(hoursUntil * 60)} min${event.location ? ` — ${sanitizeSnippet(event.location)}` : ""}`
            : `Starts ${formatLocaleDateTime(starts, input.locale)}${event.location ? ` — ${sanitizeSnippet(event.location)}` : ""}`,
        targetAt: starts.toISOString(),
        occurredAt: event.updated_at
          ? new Date(event.updated_at as unknown as string).toISOString()
          : input.now,
        priorityCandidate: {
          startsAt: starts.toISOString()
        }
      });
    }

    return { signals, nextCursor: { checkedAt: input.now } };
  }
};
