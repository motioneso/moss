import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ActionAuditLogEntryDto, ActivityLineDto, LocaleSettingsDto } from "@moss/shared";
import { localDay } from "@moss/shared";
import { Button, Checklist, Eyebrow, type ChecklistItem } from "@moss/ui";

import { listActionAuditLog, listActivityLines } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAssistantName } from "../api/use-assistant-name.js";
import { formatDate, formatDateTime, formatTime, useUserLocale } from "../locale/locale-format.js";
import { ActivityDialog, type ActivityDialogData } from "./settings-activity-dialog.js";
import {
  DEFAULT_ACTIVITY_FILTERS,
  NO_MODEL_FILTER_KEY,
  SYSTEM_MODULE_FILTER,
  isDefaultActivityFilters,
  lineActivityModule,
  loadActivityFilters,
  modelsButtonLabel,
  saveActivityFilters,
  toolRowHiddenByModelFilter,
  type ActivityFilters
} from "./settings-activity-filters.js";
import { browserSettingsStorage } from "./settings-storage.js";
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
import { Badge, PaneHead, Select } from "./settings-ui.js";

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
 * A model line matches the module filter by its owning module (action code mapped in
 * settings-activity-filters); the admin-only System option matches ownerless lines.
 */
function lineMatchesModule(line: ActivityLineDto, filter: string): boolean {
  if (!filter) return true;
  if (filter === SYSTEM_MODULE_FILTER) return line.ownerUserId === null;
  return lineActivityModule(line.actionCode) === filter;
}

/** A tool row matches by its module; System shows model lines only, never tool rows. */
function toolMatchesModule(entry: ActionAuditLogEntryDto, filter: string): boolean {
  if (!filter) return true;
  if (filter === SYSTEM_MODULE_FILTER) return false;
  return entry.toolModuleId === filter;
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
    facts.push(["Confidence", `${Math.round(confidence * 100)}% sure`]);
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
      title: activityTitle(line.actionCode, line.modelName),
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
          title: activityTitle(line.actionCode, line.modelName),
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
    kindLabel: child.actionCode === "chat.tool_check" ? "classifier check" : "model call",
    title: activityTitle(child.actionCode, child.modelName),
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
    title: activityTitle(line.actionCode, line.modelName),
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

export function ActivityPane({ me }: PaneProps) {
  const locale = useUserLocale();
  const assistantName = useAssistantName();
  const isAdmin = me.user.isInstanceAdmin;
  const storage = browserSettingsStorage();
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_ACTIVITY_FILTERS);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [openRow, setOpenRow] = useState<ActivityRow | null>(null);
  const hydrated = useRef(false);

  // sinceForRange derives from Date.now() for non-"today" ranges; unmemoized, it produced a new
  // ISO timestamp (and thus a new query key) on every render, so an abort/error re-render could
  // never settle into isError — it remounted a fresh isLoading query instead (PR #1117 CP5 RED).
  const since = useMemo(() => sinceForRange(filters.range), [filters.range]);

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
  const auditEntries = auditQuery.data?.entries ?? [];

  /** Models in the loaded range with their line counts, No model last. */
  const modelItems: ChecklistItem[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line.modelName, (counts.get(line.modelName) ?? 0) + 1);
    const items = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({
        id: name,
        label: name,
        count,
        checked: !filters.untickedModels.includes(name)
      }));
    if (auditEntries.length > 0) {
      items.push({
        id: NO_MODEL_FILTER_KEY,
        label: "No model (tool only)",
        count: auditEntries.length,
        checked: !filters.untickedModels.includes(NO_MODEL_FILTER_KEY)
      });
    }
    return items;
  }, [lines, auditEntries, filters.untickedModels]);

  /** Module options from the loaded data, labelled; System is admin-only and appended. */
  const moduleOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const line of lines) {
      const owner = lineActivityModule(line.actionCode);
      if (owner) ids.add(owner);
    }
    for (const entry of auditEntries) ids.add(entry.toolModuleId);
    return [...ids].sort((a, b) => moduleLabel(a).localeCompare(moduleLabel(b)));
  }, [lines, auditEntries]);

  // Saved filters restore once the first load lands, against the models and modules the
  // range actually names; unknown saved values are dropped. Persistence waits for this
  // so the defaults never overwrite the saved choice.
  useEffect(() => {
    if (hydrated.current || linesQuery.isLoading || auditQuery.isLoading) return;
    if (linesQuery.isError || auditQuery.isError) return;
    hydrated.current = true;
    setFilters(
      loadActivityFilters(
        storage,
        me.user.id,
        modelItems.map((item) => item.id),
        moduleOptions
      )
    );
  }, [
    storage,
    me.user.id,
    linesQuery.isLoading,
    linesQuery.isError,
    auditQuery.isLoading,
    auditQuery.isError,
    modelItems,
    moduleOptions
  ]);

  useEffect(() => {
    if (!hydrated.current) return;
    saveActivityFilters(storage, me.user.id, filters);
  }, [storage, me.user.id, filters]);

  const toggleModel = (id: string): void => {
    setFilters((current) => ({
      ...current,
      untickedModels: current.untickedModels.includes(id)
        ? current.untickedModels.filter((name) => name !== id)
        : [...current.untickedModels, id]
    }));
  };

  const moduleRows = useMemo(
    () =>
      groupActivity(
        lines.filter((line) => lineMatchesModule(line, filters.module)),
        auditEntries.filter((entry) => toolMatchesModule(entry, filters.module))
      ),
    [lines, auditEntries, filters.module]
  );
  const rows = useMemo(
    () =>
      groupActivity(
        lines.filter(
          (line) =>
            lineMatchesModule(line, filters.module) &&
            !filters.untickedModels.includes(line.modelName)
        ),
        auditEntries.filter(
          (entry) =>
            toolMatchesModule(entry, filters.module) &&
            !toolRowHiddenByModelFilter(filters.untickedModels)
        )
      ),
    [lines, auditEntries, filters]
  );
  const hiddenByModel = moduleRows.length - rows.length;
  const tickedCount = modelItems.filter((item) => item.checked).length;

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
    <div>
      <PaneHead
        title="Activity"
        desc={`What ${assistantName} did for you, which model did it, and how it went. Only you can see these details.`}
      />

      <div className="act-filters">
        <div className="act-filters__group" role="group" aria-label="Time range">
          {(["today", "7d", "30d", "90d"] as DateRange[]).map((r) => (
            <Button
              key={r}
              variant="quiet"
              size="sm"
              active={filters.range === r}
              aria-pressed={filters.range === r}
              onClick={() => setFilters((current) => ({ ...current, range: r }))}
            >
              {RANGE_LABELS[r]}
            </Button>
          ))}
        </div>
        <Select
          aria-label="Filter by module"
          value={filters.module}
          onChange={(e) => setFilters((current) => ({ ...current, module: e.target.value }))}
        >
          <option value="">All modules</option>
          {moduleOptions.map((id) => (
            <option key={id} value={id}>
              {moduleLabel(id)}
            </option>
          ))}
          {isAdmin && <option value={SYSTEM_MODULE_FILTER}>System</option>}
        </Select>
        <div className="act-filters__models">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={modelsOpen}
            onClick={() => setModelsOpen((open) => !open)}
          >
            {modelsButtonLabel(tickedCount, modelItems.length)}
          </Button>
          {modelsOpen && (
            <Checklist
              items={modelItems}
              ariaLabel="Models to show"
              onToggle={toggleModel}
              onTickAll={() => setFilters((current) => ({ ...current, untickedModels: [] }))}
              onDone={() => setModelsOpen(false)}
              onClose={() => setModelsOpen(false)}
            />
          )}
        </div>
        <span className="act-filters__spacer" />
        {hiddenByModel > 0 && (
          <span className="act-hidden-note">
            {hiddenByModel} {hiddenByModel === 1 ? "entry" : "entries"} hidden by the model filter
          </span>
        )}
        {!isDefaultActivityFilters(filters) && (
          <Button variant="quiet" size="sm" onClick={() => setFilters(DEFAULT_ACTIVITY_FILTERS)}>
            Reset filters
          </Button>
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
          <p>
            {lines.length > 0 || auditEntries.length > 0
              ? "No activity matches these filters."
              : `No ${assistantName} activity in this period.`}
          </p>
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
              <Eyebrow>{dayLabel(day.key, day.sample, locale)}</Eyebrow>
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
      aria-label={activityTitle(line.actionCode, line.modelName)}
      onClick={onOpen}
      onKeyDown={openOnKey(onOpen)}
    >
      <span className="act-line__time" title={formatDateTime(line.occurredAt, locale)}>
        {formatTime(line.occurredAt, locale)}
      </span>
      <div className="act-line__text">
        <span className="act-line__title">{activityTitle(line.actionCode, line.modelName)}</span>
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
