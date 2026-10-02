import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, EmptyState } from "@moss/ui";
import type { LocaleSettingsDto, ModelActivityEntryDto } from "@moss/shared";

import { listModelActivity } from "../api/client.js";
import { formatDate, formatTime, useUserLocale } from "../locale/locale-format.js";
import type { PaneProps } from "./settings-types.js";
import { Badge, Select } from "./settings-ui.js";

type TimeRange = "all" | "24h" | "7d";

const PAGE_SIZE = 100;

const RANGE_LABELS: Record<TimeRange, string> = {
  all: "All time",
  "24h": "Last 24 hours",
  "7d": "Last 7 days"
};

const KIND_LABELS: Record<string, string> = {
  chat: "Chat answer",
  structured: "Structured call",
  transcription: "Transcription"
};

const OUTCOME_LABELS: Record<string, string> = {
  ok: "Answered",
  error: "Failed",
  aborted: "Stopped"
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

function outcomeTone(outcome: string): "forest" | "red" | "neutral" {
  if (outcome === "ok") return "forest";
  if (outcome === "error") return "red";
  return "neutral";
}

function sinceForRange(range: TimeRange): number | null {
  if (range === "all") return null;
  const hours = range === "24h" ? 24 : 24 * 7;
  return Date.now() - hours * 60 * 60 * 1000;
}

function localDayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(iso: string, locale: LocaleSettingsDto): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (localDayKey(iso) === localDayKey(today.toISOString())) return "Today";
  if (localDayKey(iso) === localDayKey(yesterday.toISOString())) return "Yesterday";
  return formatDate(iso, locale, { weekday: "long", month: "long", day: "numeric" });
}

function timeLabel(iso: string, locale: LocaleSettingsDto): string {
  return formatTime(iso, locale);
}

function optionValues(
  entries: readonly ModelActivityEntryDto[],
  pick: (entry: ModelActivityEntryDto) => string
): string[] {
  return Array.from(new Set(entries.map(pick))).sort((a, b) => a.localeCompare(b));
}

export function ModelActivityPane(_props: PaneProps) {
  const locale = useUserLocale();
  const [entries, setEntries] = useState<readonly ModelActivityEntryDto[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [nextBeforeId, setNextBeforeId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [range, setRange] = useState<TimeRange>("all");
  const [kindFilter, setKindFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await listModelActivity({ limit: PAGE_SIZE });
      setEntries(response.entries);
      setNextBefore(response.nextBefore);
      setNextBeforeId(response.nextBeforeId);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = useCallback(async () => {
    if (!nextBefore) return;
    setLoadingOlder(true);
    try {
      const response = await listModelActivity({
        limit: PAGE_SIZE,
        before: nextBefore,
        ...(nextBeforeId ? { beforeId: nextBeforeId } : {})
      });
      setEntries((previous) => [...previous, ...response.entries]);
      setNextBefore(response.nextBefore);
      setNextBeforeId(response.nextBeforeId);
    } catch {
      // Keep what is already on screen; the button simply stays available.
    } finally {
      setLoadingOlder(false);
    }
  }, [nextBefore, nextBeforeId]);

  const kinds = useMemo(() => optionValues(entries, (entry) => entry.kind), [entries]);
  const models = useMemo(() => optionValues(entries, (entry) => entry.modelName), [entries]);
  const outcomes = useMemo(() => optionValues(entries, (entry) => entry.outcome), [entries]);

  const filtered = useMemo(() => {
    const since = sinceForRange(range);
    return entries.filter((entry) => {
      if (since !== null && new Date(entry.occurredAt).getTime() < since) return false;
      if (kindFilter && entry.kind !== kindFilter) return false;
      if (modelFilter && entry.modelName !== modelFilter) return false;
      if (resultFilter && entry.outcome !== resultFilter) return false;
      return true;
    });
  }, [entries, range, kindFilter, modelFilter, resultFilter]);

  const hasFilters = Boolean(kindFilter || modelFilter || resultFilter || range !== "all");

  const clearFilters = useCallback(() => {
    setKindFilter("");
    setModelFilter("");
    setResultFilter("");
    setRange("all");
  }, []);

  const groups = useMemo(() => {
    const ordered: Array<{ day: string; entries: ModelActivityEntryDto[] }> = [];
    for (const entry of filtered) {
      const day = localDayKey(entry.occurredAt);
      const last = ordered.at(-1);
      if (last && last.day === day) {
        last.entries.push(entry);
      } else {
        ordered.push({ day, entries: [entry] });
      }
    }
    return ordered;
  }, [filtered]);

  return (
    <div className="settings-section">
      <header className="settings-section__header">
        <h2 className="settings-section__title">Model activity</h2>
        <p className="settings-section__desc">
          Every model call Moss makes: chat turns through CLI and API-key providers, structured
          output including classifier choices, transcription, embeddings, background tasks, module
          builds, and provider probes and checks.
        </p>
      </header>

      {status !== "error" && (
        <div className="audfilter">
          <Select
            aria-label="Filter by kind"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="">All kinds</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(kind)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by model"
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
          >
            <option value="">All models</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by result"
            value={resultFilter}
            onChange={(event) => setResultFilter(event.target.value)}
          >
            <option value="">All results</option>
            {outcomes.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomeLabel(outcome)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by time"
            value={range}
            onChange={(event) => setRange(event.target.value as TimeRange)}
          >
            {(Object.keys(RANGE_LABELS) as TimeRange[]).map((option) => (
              <option key={option} value={option}>
                {RANGE_LABELS[option]}
              </option>
            ))}
          </Select>
        </div>
      )}

      {status === "error" && (
        <div className="aud__empty" aria-live="polite">
          <p>Model activity unavailable.</p>
          <Button variant="quiet" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {status === "loading" && (
        <div className="aud__empty" aria-live="polite">
          Loading…
        </div>
      )}

      {status === "ready" && entries.length === 0 && (
        <EmptyState title="No activity yet" description="Lines appear once Moss calls a model." />
      )}

      {status === "ready" && entries.length > 0 && filtered.length === 0 && (
        <EmptyState title="No lines match these filters" description="Try a wider range.">
          <Button variant="secondary" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </EmptyState>
      )}

      {status === "ready" && filtered.length > 0 && (
        <>
          <div className="aud">
            {groups.map((group) => (
              <div key={group.day}>
                <div className="jds-eyebrow">{dayLabel(group.entries[0]!.occurredAt, locale)}</div>
                {group.entries.map((entry) => (
                  <div key={entry.id} className="aud__row">
                    <div className="aud__when">{timeLabel(entry.occurredAt, locale)}</div>
                    <div className="aud__what">
                      <b>{entry.action}</b>
                      <div className="aud__badges">
                        <Badge tone="neutral">{kindLabel(entry.kind)}</Badge>
                        <Badge tone={outcomeTone(entry.outcome)}>
                          {outcomeLabel(entry.outcome)}
                        </Badge>
                      </div>
                    </div>
                    <div className="aud__cat">{entry.modelName}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {nextBefore && (
            <div className="aud__count">
              <Button variant="quiet" size="sm" onClick={() => void loadOlder()}>
                {loadingOlder ? "Loading…" : "Load older"}
              </Button>
            </div>
          )}
          {hasFilters && filtered.length > 0 && (
            <div className="audfilter">
              <Button variant="quiet" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
