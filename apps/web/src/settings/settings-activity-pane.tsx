import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@moss/ui";
import { listActionAuditLog } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAssistantName } from "../api/use-assistant-name.js";
import { formatDateTime, useUserLocale } from "../locale/locale-format.js";
import type { PaneProps } from "./settings-types.js";
import { Badge, Select } from "./settings-ui.js";
import type { ActionAuditLogEntryDto } from "@moss/shared";

type DateRange = "today" | "7d" | "30d" | "90d";

const RANGE_LABELS: Record<DateRange, string> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days"
};

function sinceForRange(range: DateRange): string {
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const offsets: Record<DateRange, number> = {
    today: 0,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000
  };
  return new Date(Date.now() - offsets[range]).toISOString();
}

function approvalLabel(mode: ActionAuditLogEntryDto["approvalMode"]): string {
  const labels: Record<typeof mode, string> = {
    auto: "Auto-run",
    yolo: "YOLO",
    confirmed: "Confirmed",
    rejected: "Declined",
    cancelled: "Cancelled",
    timeout: "Timed out"
  };
  return labels[mode];
}

function outcomeLabel(outcome: ActionAuditLogEntryDto["outcome"]): string {
  const labels: Record<typeof outcome, string> = {
    success: "Done",
    failed: "Failed",
    denied: "Declined",
    cancelled: "Cancelled",
    invalid: "Invalid",
    conflict: "Conflict",
    suppressed: "Skipped (already covered)",
    refused: "Refused (too many requests)"
  };
  return labels[outcome];
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function isDistinct(outcome: ActionAuditLogEntryDto["outcome"]): boolean {
  return (
    outcome === "failed" ||
    outcome === "denied" ||
    outcome === "invalid" ||
    outcome === "conflict" ||
    outcome === "refused"
  );
}

export function ActivityPane(_props: PaneProps) {
  const locale = useUserLocale();
  const assistantName = useAssistantName();
  const [range, setRange] = useState<DateRange>("30d");
  const [familyFilter, setFamilyFilter] = useState<string>("");

  // sinceForRange derives from Date.now() for non-"today" ranges; unmemoized, it produced a new
  // ISO timestamp (and thus a new query key) on every render, so an abort/error re-render could
  // never settle into isError — it remounted a fresh isLoading query instead (PR #1117 CP5 RED).
  const since = useMemo(() => sinceForRange(range), [range]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.ai.actionAuditLog({ since }),
    queryFn: () => listActionAuditLog({ since, limit: 200 }),
    retry: false
  });

  const entries = data?.entries ?? [];

  const families = Array.from(
    new Set(
      entries.filter((e) => e.actionFamilyId).map((e) => `${e.toolModuleId}/${e.actionFamilyId}`)
    )
  );

  const filtered = familyFilter
    ? entries.filter((e) => `${e.toolModuleId}/${e.actionFamilyId}` === familyFilter)
    : entries;

  return (
    <div className="settings-section">
      <header className="settings-section__header">
        <h2 className="settings-section__title">Activity</h2>
        <p className="settings-section__desc">
          Actions {assistantName} ran on your behalf, last 90 days.
        </p>
      </header>

      <div className="audfilter">
        {(["today", "7d", "30d", "90d"] as DateRange[]).map((r) => (
          <Button
            key={r}
            variant="quiet"
            size="sm"
            active={range === r}
            onClick={() => setRange(r)}
          >
            {RANGE_LABELS[r]}
          </Button>
        ))}
        {families.length > 0 && (
          <Select
            aria-label="Filter by action family"
            value={familyFilter}
            onChange={(e) => setFamilyFilter(e.target.value)}
          >
            <option value="">All actions</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        )}
      </div>

      {isError && (
        <div className="aud__empty" aria-live="polite">
          <p>Activity unavailable.</p>
          <Button variant="quiet" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}

      {!isError && isLoading && (
        <div className="aud__empty" aria-live="polite">
          Loading…
        </div>
      )}

      {!isError && !isLoading && filtered.length === 0 && (
        <div className="aud__empty">
          <p>No {assistantName} actions in this period.</p>
        </div>
      )}

      {!isError && !isLoading && filtered.length > 0 && (
        <div className="aud">
          {filtered.map((entry) => (
            <div key={entry.id} className="aud__row">
              <div className="aud__when" title={formatDateTime(entry.occurredAt, locale)}>
                {relativeTime(entry.occurredAt)}
              </div>
              <div className="aud__what">
                <b>{entry.toolName}</b>
                {entry.actionFamilyId && (
                  <>
                    {" "}
                    <span>{entry.actionFamilyId}</span>
                  </>
                )}
                <div className="aud__badges">
                  <Badge tone="neutral">{approvalLabel(entry.approvalMode)}</Badge>
                  <Badge tone={isDistinct(entry.outcome) ? "red" : "neutral"}>
                    {outcomeLabel(entry.outcome)}
                  </Badge>
                  {entry.sourceSurface !== "chat" && (
                    <Badge tone="steel">{entry.sourceSurface}</Badge>
                  )}
                </div>
              </div>
              <div className="aud__cat">{entry.toolModuleId}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
