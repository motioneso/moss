import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ActionAuditLogEntryDto, ActivityLineDto, LocaleSettingsDto } from "@moss/shared";
import { localDay } from "@moss/shared";
import { Button } from "@moss/ui";

import { listActionAuditLog, listActivityLines } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAssistantName } from "../api/use-assistant-name.js";
import { formatDate, formatDateTime, formatTime, useUserLocale } from "../locale/locale-format.js";
import { ActivityDialog, type ActivityDialogData } from "./settings-activity-dialog.js";
import {
  activityBadges,
  activityMeta,
  activityQuote,
  activitySubline,
  activityTitle,
  durationText,
  failureSentence,
  groupActivity,
  type ActivityRow
} from "./settings-activity-line.js";
import { actionLabel, moduleLabel, outcomeNote } from "./settings-activity-labels.js";
import type { PaneProps } from "./settings-types.js";
import { Badge, Select } from "./settings-ui.js";

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
    yolo: "Auto-approved",
    confirmed: "Confirmed",
    rejected: "Declined",
    cancelled: "Cancelled",
    timeout: "Timed out"
  };
  return labels[mode];
}

function dayKey(iso: string, locale: LocaleSettingsDto, now: Date): string {
  const key = localDay(iso, locale.timezone);
  return key === localDay(now, locale.timezone) ? "today" : key;
}

function dayLabel(key: string, sample: string, locale: LocaleSettingsDto): string {
  if (key === "today") return "Today";
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (key === dayKey(sample, locale, yesterday)) return "Yesterday";
  return formatDate(sample, locale);
}

/**
 * Slice C keeps the existing module dropdown (options from the loaded tool rows). A model
 * line matches the filter by its action-code prefix; anything else only shows unfiltered.
 * Slice D replaces this with manifest-driven filtering.
 */
function lineMatchesModule(line: ActivityLineDto, filter: string): boolean {
  if (!filter) return true;
  const code = line.actionCode;
  if (!code) return false;
  if (code === `structured.${filter}`) return true;
  if (filter === "memory" && code.startsWith("embed.")) return true;
  if (filter === "ai" && code.startsWith("chat.")) return true;
  return false;
}

/** A tool row's one-line result: done, or what it did not do, in fixed words. */
function toolResultText(entry: ActionAuditLogEntryDto): string {
  if (entry.outcome !== "failed") return outcomeNote(entry.outcome) ?? "Done.";
  const sentence = failureSentence(entry.errorClass);
  return `Did not work: ${sentence.charAt(0).toLowerCase() + sentence.slice(1)}`;
}

function tokensText(line: ActivityLineDto, formatInt: (value: number) => string): string | null {
  if (line.inputTokens !== null && line.outputTokens !== null) {
    return `${formatInt(line.inputTokens)} tokens in, ${formatInt(line.outputTokens)} out`;
  }
  if (line.outputTokens !== null) return `${formatInt(line.outputTokens)} tokens out`;
  if (line.inputTokens !== null) return `${formatInt(line.inputTokens)} tokens in`;
  return null;
}

function childStepFacts(
  child: ActivityLineDto,
  time: string
): ReadonlyArray<readonly [string, string]> {
  const facts: Array<readonly [string, string]> = [["Started", time]];
  if (child.durationMs !== null && child.durationMs !== undefined) {
    facts.push(["Took", durationText(child.durationMs)]);
  }
  facts.push(["Model", child.modelName]);
  const tokens: string[] = [];
  if (child.inputTokens !== null && child.inputTokens !== undefined) {
    tokens.push(`${child.inputTokens} in`);
  }
  if (child.outputTokens !== null && child.outputTokens !== undefined) {
    tokens.push(`${child.outputTokens} out`);
  }
  facts.push(["Tokens", tokens.length > 0 ? tokens.join(", ") : "None used"]);
  const confidence = child.factCounts?.confidence;
  if (child.actionCode === "chat.tool_check" && typeof confidence === "number") {
    facts.push(["Jev confidence", `${Math.round(confidence * 100)}% sure`]);
  }
  return facts;
}

function buildDialog(row: ActivityRow, locale: LocaleSettingsDto): ActivityDialogData {
  const formatInt = (value: number): string =>
    new Intl.NumberFormat(locale.region, { useGrouping: true }).format(value);
  const timeOf = (iso: string): string => formatTime(iso, locale);

  if (row.kind === "tool") {
    const entry = row.entry;
    const failed = entry.outcome === "failed";
    const duration =
      entry.durationMs !== null && entry.durationMs !== undefined
        ? durationText(entry.durationMs)
        : null;
    return {
      title: actionLabel(entry),
      statusText: failed ? "Did not work" : "Done",
      statusTone: failed ? "red" : "forest",
      badges: [],
      meta: ["Chat", timeOf(entry.occurredAt), duration].filter(Boolean).join(" - "),
      quote: null,
      steps: [
        {
          key: entry.id,
          kindLabel: "tool action",
          title: actionLabel(entry),
          result: toolResultText(entry),
          meta: [moduleLabel(entry.toolModuleId), approvalLabel(entry.approvalMode), duration]
            .filter(Boolean)
            .join(" - "),
          failed,
          failureCode: entry.errorClass,
          facts: [
            ["Started", timeOf(entry.occurredAt)],
            ...(duration ? [["Took", duration] as const] : []),
            ["Approval", approvalLabel(entry.approvalMode)],
            ["Model", "None, this step is a tool action"],
            ["Tokens", "None used"]
          ],
          askedFor: null,
          returned: null
        }
      ],
      expiresAt: null
    };
  }

  const line = row.line;
  const isAnswer = line.actionCode === "chat.answer";
  const failed = line.outcome === "error";
  const duration =
    line.durationMs !== null && line.durationMs !== undefined
      ? durationText(line.durationMs)
      : null;
  const quote = line.detail?.quote ? activityQuote(line.detail.quote) : null;

  if (!isAnswer) {
    const selfFacts: Array<readonly [string, string]> = [["Started", timeOf(line.occurredAt)]];
    if (duration) selfFacts.push(["Took", duration]);
    selfFacts.push(["Model", line.modelName]);
    const tokens = tokensText(line, formatInt);
    selfFacts.push(["Tokens", tokens ?? "None used"]);
    return {
      title: activityTitle(line.actionCode, line.action),
      statusText: failed ? "Did not work" : line.outcome === "aborted" ? "Stopped" : "Done",
      statusTone: failed ? "red" : line.outcome === "aborted" ? "neutral" : "forest",
      badges: activityBadges(line),
      meta: [
        formatDate(line.occurredAt, locale),
        timeOf(line.occurredAt),
        line.modelName,
        duration ? `${duration} in total` : null,
        tokens
      ]
        .filter(Boolean)
        .join(" - "),
      quote,
      steps: [
        {
          key: line.id,
          kindLabel: "model call",
          title: activityTitle(line.actionCode, line.action),
          result: activitySubline(line),
          meta: duration ? `${line.modelName} - ${duration}` : line.modelName,
          failed,
          failureCode: line.failureCode,
          facts: selfFacts,
          askedFor: null,
          returned: null
        },
        ...(line.detail?.steps.map((recorded, index) => ({
          key: `${line.id}-recorded-${index}`,
          kindLabel: "model call" as const,
          title: recorded.title,
          result: recorded.result,
          meta: null,
          failed: false,
          failureCode: null,
          facts: [] as ReadonlyArray<readonly [string, string]>,
          askedFor: recorded.askedFor ?? null,
          returned: recorded.returned ?? null
        })) ?? [])
      ],
      expiresAt: line.detail?.expiresAt ?? null
    };
  }

  const childSteps = row.children.map((child) => ({
    key: child.id,
    kindLabel: child.actionCode === "chat.tool_check" ? "Jev check" : "model call",
    title: activityTitle(child.actionCode, child.action),
    result: child.detail?.resultLine ?? activitySubline(child),
    meta:
      child.durationMs !== null && child.durationMs !== undefined
        ? `${child.modelName} - ${durationText(child.durationMs)}`
        : child.modelName,
    failed: child.outcome === "error",
    failureCode: child.failureCode,
    facts: childStepFacts(child, timeOf(child.occurredAt)),
    askedFor: null as string | null,
    returned: null as string | null
  }));

  const toolSteps = row.tools.map((entry) => {
    const toolFailed = entry.outcome === "failed";
    const took =
      entry.durationMs !== null && entry.durationMs !== undefined
        ? durationText(entry.durationMs)
        : null;
    return {
      key: entry.id,
      kindLabel: "tool action",
      title: actionLabel(entry),
      result: toolResultText(entry),
      meta: [moduleLabel(entry.toolModuleId), approvalLabel(entry.approvalMode), took]
        .filter(Boolean)
        .join(" - "),
      failed: toolFailed,
      failureCode: entry.errorClass,
      failureService: moduleLabel(entry.toolModuleId),
      facts: [
        ["Started", timeOf(entry.occurredAt)],
        ...(took ? [["Took", took] as const] : []),
        ["Approval", approvalLabel(entry.approvalMode)],
        ["Model", "None, this step is a tool action"],
        ["Tokens", "None used"]
      ] as ReadonlyArray<readonly [string, string]>,
      askedFor: null as string | null,
      returned: null as string | null
    };
  });

  const recordedAnswer = line.detail?.steps.find((recordedStep) => recordedStep.title === "Answer");
  const answerResult = recordedAnswer?.result ?? line.detail?.resultLine ?? activitySubline(line);
  const tokens = tokensText(line, formatInt);
  const steps = [
    ...childSteps,
    ...toolSteps,
    {
      key: `${line.id}-answer`,
      kindLabel: "answer",
      title: "Wrote the answer",
      result: answerResult,
      meta: [
        line.modelName,
        duration,
        line.outputTokens !== null && line.outputTokens !== undefined
          ? `${formatInt(line.outputTokens)} tokens out`
          : null
      ]
        .filter(Boolean)
        .join(" - "),
      failed: false,
      failureCode: null,
      facts: [
        ["Started", timeOf(line.occurredAt)],
        ...(duration ? [["Took", duration] as const] : []),
        ["Model", line.modelName],
        ["Tokens", tokens ?? "None used"]
      ] as ReadonlyArray<readonly [string, string]>,
      askedFor: null as string | null,
      returned: null as string | null
    }
  ];

  return {
    title: activityTitle(line.actionCode, line.action),
    statusText: failed ? "Did not work" : line.outcome === "aborted" ? "Stopped" : "Done",
    statusTone: failed ? "red" : line.outcome === "aborted" ? "neutral" : "forest",
    badges: activityBadges(line),
    meta: [
      formatDate(line.occurredAt, locale),
      timeOf(line.occurredAt),
      line.modelName,
      duration ? `${duration} in total` : null,
      tokens,
      "from chat"
    ]
      .filter(Boolean)
      .join(" - "),
    quote,
    steps,
    expiresAt: line.detail?.expiresAt ?? null
  };
}

function rowKey(row: ActivityRow): string {
  return row.kind === "line" ? row.line.id : row.entry.id;
}

export function ActivityPane(_props: PaneProps) {
  const locale = useUserLocale();
  const assistantName = useAssistantName();
  const [range, setRange] = useState<DateRange>("30d");
  const [familyFilter, setFamilyFilter] = useState<string>("");
  const [openRow, setOpenRow] = useState<ActivityRow | null>(null);

  // sinceForRange derives from Date.now() for non-"today" ranges; unmemoized, it produced a new
  // ISO timestamp (and thus a new query key) on every render, so an abort/error re-render could
  // never settle into isError — it remounted a fresh isLoading query instead (PR #1117 CP5 RED).
  const since = useMemo(() => sinceForRange(range), [range]);

  const linesQuery = useQuery({
    queryKey: queryKeys.ai.activityLines({ since, limit: 200 }),
    queryFn: () => listActivityLines({ since, limit: 200 }),
    retry: false
  });
  const auditQuery = useQuery({
    queryKey: queryKeys.ai.actionAuditLog({ since }),
    queryFn: () => listActionAuditLog({ since, limit: 200 }),
    retry: false
  });

  const lines = linesQuery.data?.entries ?? [];
  const audits = useMemo(
    () =>
      (auditQuery.data?.entries ?? []).filter(
        (entry) => !familyFilter || entry.toolModuleId === familyFilter
      ),
    [auditQuery.data, familyFilter]
  );
  const rows = useMemo(
    () =>
      groupActivity(
        lines.filter((line) => lineMatchesModule(line, familyFilter)),
        audits
      ),
    [lines, audits, familyFilter]
  );

  const families = Array.from(new Set((auditQuery.data?.entries ?? []).map((e) => e.toolModuleId)));

  const days = useMemo(() => {
    const now = new Date();
    const groups = new Map<string, { key: string; sample: string; rows: ActivityRow[] }>();
    for (const row of rows) {
      const occurredAt = row.kind === "line" ? row.line.occurredAt : row.entry.occurredAt;
      const key = dayKey(occurredAt, locale, now);
      const group = groups.get(key) ?? { key, sample: occurredAt, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [rows, locale]);

  const isError = linesQuery.isError || auditQuery.isError;
  const isLoading = linesQuery.isLoading || auditQuery.isLoading;
  const refetch = (): void => {
    void linesQuery.refetch();
    void auditQuery.refetch();
  };

  return (
    <div className="settings-section">
      <header className="settings-section__header">
        <h2 className="settings-section__title">Activity</h2>
        <p className="settings-section__desc">
          What {assistantName} did for you, which model did it, and how it went. Only you can see
          these details.
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
            aria-label="Filter by module"
            value={familyFilter}
            onChange={(e) => setFamilyFilter(e.target.value)}
          >
            <option value="">All modules</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {moduleLabel(f)}
              </option>
            ))}
          </Select>
        )}
      </div>

      {isError && (
        <div className="aud__empty" aria-live="polite">
          <p>Activity unavailable.</p>
          <Button variant="quiet" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      )}

      {!isError && isLoading && (
        <div className="aud__empty" aria-live="polite">
          Loading…
        </div>
      )}

      {!isError && !isLoading && rows.length === 0 && (
        <div className="aud__empty">
          <p>No {assistantName} activity in this period.</p>
        </div>
      )}

      {!isError && !isLoading && rows.length > 0 && (
        <div>
          {days.map((day) => (
            <section
              key={day.key}
              className="act-day"
              aria-label={dayLabel(day.key, day.sample, locale)}
            >
              <span className="jds-eyebrow">{dayLabel(day.key, day.sample, locale)}</span>
              {day.rows.map((row) =>
                row.kind === "line" ? (
                  <ActivityLineRow
                    key={rowKey(row)}
                    row={row}
                    locale={locale}
                    onOpen={() => setOpenRow(row)}
                  />
                ) : (
                  <ActivityToolRow
                    key={rowKey(row)}
                    entry={row.entry}
                    locale={locale}
                    onOpen={() => setOpenRow(row)}
                  />
                )
              )}
            </section>
          ))}
        </div>
      )}

      {openRow && (
        <ActivityDialog
          data={buildDialog(openRow, locale)}
          locale={locale}
          onClose={() => setOpenRow(null)}
        />
      )}
    </div>
  );
}

function openOnKey(open: () => void): (event: React.KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
}

function ActivityLineRow(props: {
  readonly row: Extract<ActivityRow, { kind: "line" }>;
  readonly locale: LocaleSettingsDto;
  readonly onOpen: () => void;
}) {
  const { row, locale, onOpen } = props;
  const { line, children, tools } = row;
  const stepCount = line.actionCode === "chat.answer" ? children.length + tools.length + 1 : null;
  const quote = line.detail?.quote ? activityQuote(line.detail.quote) : null;
  const badges = activityBadges(line);
  return (
    <div
      className="act-line"
      role="button"
      tabIndex={0}
      aria-label={activityTitle(line.actionCode, line.action)}
      onClick={onOpen}
      onKeyDown={openOnKey(onOpen)}
    >
      <span className="act-line__time" title={formatDateTime(line.occurredAt, locale)}>
        {formatTime(line.occurredAt, locale)}
      </span>
      <div className="act-line__text">
        <span className="act-line__title">{activityTitle(line.actionCode, line.action)}</span>
        {quote && <span className="act-line__quote">{quote}</span>}
        <span className="act-line__result">{activitySubline(line)}</span>
        <span className="act-line__meta">{activityMeta(line, stepCount)}</span>
      </div>
      <div className="act-line__badges">
        {badges.map((badge) => (
          <Badge key={badge.text} tone={badge.tone}>
            {badge.text}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function ActivityToolRow(props: {
  readonly entry: ActionAuditLogEntryDto;
  readonly locale: LocaleSettingsDto;
  readonly onOpen: () => void;
}) {
  const { entry, locale, onOpen } = props;
  const duration =
    entry.durationMs !== null && entry.durationMs !== undefined
      ? durationText(entry.durationMs)
      : null;
  const result = toolResultText(entry);
  return (
    <div
      className="act-line"
      role="button"
      tabIndex={0}
      aria-label={actionLabel(entry)}
      onClick={onOpen}
      onKeyDown={openOnKey(onOpen)}
    >
      <span className="act-line__time" title={formatDateTime(entry.occurredAt, locale)}>
        {formatTime(entry.occurredAt, locale)}
      </span>
      <div className="act-line__text">
        <span className="act-line__title">{actionLabel(entry)}</span>
        <span className="act-line__result">{result}</span>
        <span className="act-line__meta">
          {[duration ? `no model - ${duration}` : "no model", moduleLabel(entry.toolModuleId)]
            .filter(Boolean)
            .join(" - ")}
        </span>
      </div>
      <div className="act-line__badges">
        {entry.outcome === "failed" && <Badge tone="red">Did not work</Badge>}
      </div>
    </div>
  );
}
