import { Button, RowButton } from "@moss/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Flag, Reply } from "lucide-react";

import type {
  BriefingActionCategory,
  BriefingActionRowDto,
  BriefingRunDto,
  LocaleSettingsDto,
  SourceFreshnessV1,
  TaskDto
} from "@moss/shared";

import { updateTask } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { formatDate } from "../locale/locale-format";
import { useChatControls } from "../shell/chat-controls-context";

import { BriefingStaleBanner } from "./briefing-freshness";
import { buildReplyChatPrompt } from "./briefing-reply-prompt";
import { BriefingCatchUp } from "./catch-up-digest";
import { driftOf } from "./today-labels.js";

const DRIFT_CLASS: Record<NonNullable<ReturnType<typeof driftOf>>, string> = {
  atrisk: "jds-drift jds-drift--atrisk",
  overdue: "jds-drift jds-drift--overdue"
};

export { buildReplyChatPrompt };

export interface BriefingActionRowsSectionProps {
  readonly run: BriefingRunDto | null;
  readonly loading: boolean;
  readonly tasks: readonly TaskDto[];
  readonly looseEnds: readonly TaskDto[];
  readonly locale: LocaleSettingsDto;
  readonly chatAvailable: boolean;
  readonly onOpenTask: (taskId: string) => void;
}

export interface DisplayedActionRow {
  readonly row: BriefingActionRowDto;
  readonly liveStatus: "suggested" | "accepted" | "dismissed";
}

/**
 * A row's status in the payload is frozen at compose time; the task table is the live truth. Join
 * on it so a row accepted after the briefing ran shows as Accepted rather than still asking.
 */
export function joinActionRowsToTasks(
  rows: readonly BriefingActionRowDto[],
  tasks: readonly TaskDto[]
): readonly DisplayedActionRow[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const displayed: DisplayedActionRow[] = [];
  for (const row of rows) {
    const task = byId.get(row.taskId);
    if (!task) continue;
    if (task.status === "suggested") displayed.push({ row, liveStatus: "suggested" });
    else if (task.status === "todo" || task.status === "done")
      displayed.push({ row, liveStatus: "accepted" });
    else if (task.status === "archived") displayed.push({ row, liveStatus: "dismissed" });
  }
  return displayed;
}

const CATEGORY_ICON: Record<BriefingActionCategory, typeof Reply> = {
  needs_reply: Reply,
  needs_action: Flag,
  time_sensitive_info: Clock
};

export function BriefingActionRowsSection(props: BriefingActionRowsSectionProps) {
  const queryClient = useQueryClient();
  const chat = useChatControls();
  const triageMutation = useMutation({
    mutationFn: (input: { readonly taskId: string; readonly status: "todo" | "archived" }) =>
      updateTask(input.taskId, { status: input.status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.briefings.runs(props.run?.definitionId ?? null)
      });
    }
  });

  const displayed = props.run
    ? joinActionRowsToTasks(props.run.structuredPayload.actionRows, props.tasks)
    : rowsFromSuggestedTasks(props.tasks);
  const suggested = displayed.filter((entry) => entry.liveStatus === "suggested");
  const catchUp = props.run?.structuredPayload.catchUp ?? null;
  const looseEndsSection =
    props.looseEnds.length > 0 ? (
      <section className="briefing-loose-ends" id="loose-ends" aria-labelledby="loose-ends-heading">
        <div className="briefing-loose-ends__head">
          <span className="jds-brief__kicker" id="loose-ends-heading">
            Loose ends
          </span>
          <span className="jds-caption">{props.looseEnds.length}</span>
        </div>
        <div className="loose">
          {props.looseEnds.map((task) => {
            const drift = driftOf(task, props.locale.timezone);
            const driftClass = DRIFT_CLASS[drift ?? "atrisk"];
            return (
              <div className="jds-task" key={task.id}>
                <span className="jds-task__check">
                  <Flag size={15} aria-hidden="true" />
                </span>
                <RowButton className="jds-task__main" onClick={() => props.onOpenTask(task.id)}>
                  <div className="jds-task__title">{task.title}</div>
                  <div className="jds-task__meta">
                    <span className={driftClass}>
                      <span className="jds-drift__dot" />
                      {drift === "overdue" ? "Overdue" : "At risk"}
                    </span>
                    <span className="jds-task__source">{task.source}</span>
                  </div>
                </RowButton>
              </div>
            );
          })}
        </div>
      </section>
    ) : null;

  if (props.loading) {
    return (
      <section className="jds-brief">
        <div className="jds-brief__head">
          <span className="jds-brief__kicker">Needs you</span>
        </div>
        <p className="cmd-empty" role="status">
          Checking what needs you…
        </p>
        {looseEndsSection}
      </section>
    );
  }

  if (!props.run && displayed.length === 0 && props.looseEnds.length === 0) return null;

  const needsYouCount = suggested.length + props.looseEnds.length;
  const countLabel = `${needsYouCount} ${needsYouCount === 1 ? "needs" : "need"} you`;
  const freshness = buildFreshness(displayed, props.run?.createdAt ?? null);

  return (
    <section className="jds-brief">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Needs you</span>
      </div>
      <div className="jds-brief__title">{countLabel}</div>
      {freshness ? <BriefingStaleBanner freshness={freshness} /> : null}
      {displayed.length === 0 && props.looseEnds.length === 0 ? (
        <p className="cmd-empty">You&apos;re caught up — nothing is waiting on you.</p>
      ) : displayed.length > 0 ? (
        <div className="loose">
          {displayed.map((entry) => (
            <ActionRow
              key={entry.row.taskId}
              entry={entry}
              locale={props.locale}
              chatAvailable={props.chatAvailable}
              pending={triageMutation.isPending}
              onOpenTask={props.onOpenTask}
              onOpenChat={chat.openChatWith}
              onTriage={(status) => triageMutation.mutate({ taskId: entry.row.taskId, status })}
            />
          ))}
        </div>
      ) : null}
      {looseEndsSection}
      {catchUp && catchUp.entries.length > 0 ? (
        <BriefingCatchUp
          key={props.run?.id}
          catchUp={catchUp}
          locale={props.locale}
          chatAvailable={props.chatAvailable}
          onOpenChat={chat.openChatWith}
        />
      ) : null}
    </section>
  );
}

function ActionRow(props: {
  readonly entry: DisplayedActionRow;
  readonly locale: LocaleSettingsDto;
  readonly chatAvailable: boolean;
  readonly pending: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (prompt: string) => void;
  readonly onTriage: (status: "todo" | "archived") => void;
}) {
  const { row, liveStatus } = props.entry;
  const Icon = CATEGORY_ICON[row.category];

  return (
    <div className="loose-row">
      <span className="loose-row__ic">
        <Icon size={15} aria-hidden="true" />
      </span>
      <RowButton className="loose-row__main" onClick={() => props.onOpenTask(row.taskId)}>
        <div className="loose-row__title">{row.title}</div>
        <div className="loose-row__meta">{row.explanation}</div>
        <div className="loose-row__meta">{metaLabel(row, props.locale)}</div>
      </RowButton>
      <div className="loose-row__act">
        {liveStatus === "suggested" ? (
          <>
            <PrimaryControl
              row={row}
              chatAvailable={props.chatAvailable}
              onOpenChat={props.onOpenChat}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={props.pending}
              onClick={() => props.onTriage("todo")}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="quiet"
              disabled={props.pending}
              onClick={() => props.onTriage("archived")}
            >
              Dismiss
            </Button>
          </>
        ) : (
          <span className="loose-row__meta">
            {liveStatus === "accepted" ? "Accepted" : "Dismissed"}
          </span>
        )}
      </div>
    </div>
  );
}

function PrimaryControl(props: {
  readonly row: BriefingActionRowDto;
  readonly chatAvailable: boolean;
  readonly onOpenChat: (prompt: string) => void;
}) {
  const { row } = props;
  switch (row.category) {
    case "needs_reply": {
      if (row.primaryAction?.kind !== "reply") return null;
      const cacheMessageId = row.primaryAction.cacheMessageId;
      return (
        <Button
          size="sm"
          variant="secondary"
          disabled={!props.chatAvailable}
          title={props.chatAvailable ? undefined : "Chat is unavailable right now."}
          onClick={() => props.onOpenChat(buildReplyChatPrompt(cacheMessageId))}
        >
          Reply
        </Button>
      );
    }
    case "needs_action":
    case "time_sensitive_info": {
      // Only the host-supplied href is ever used as a URL — never row text.
      if (row.primaryAction?.kind !== "view") return null;
      return (
        <a
          className="jds-btn jds-btn--sm jds-btn--quiet"
          href={row.primaryAction.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          View
        </a>
      );
    }
  }
}

function metaLabel(row: BriefingActionRowDto, locale: LocaleSettingsDto): string {
  const due = row.dueAt
    ? "Due " + formatDate(row.dueAt, locale, { month: "short", day: "numeric" })
    : null;
  const resurface =
    row.resurfaceReason === "due_tomorrow"
      ? "Back — due tomorrow"
      : row.resurfaceReason === "relevant_context"
        ? "Back — related to active work"
        : null;
  return [row.sourceLabel, due, "Updated " + formatUpdatedAge(row.computedAt), resurface]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function formatUpdatedAge(computedAt: string): string {
  const timestamp = Date.parse(computedAt);
  if (Number.isNaN(timestamp)) return "unknown";
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return String(Math.round(ageMs / 60_000)) + "m ago";
  if (ageMs < 86_400_000) return String(Math.round(ageMs / 3_600_000)) + "h ago";
  return String(Math.round(ageMs / 86_400_000)) + "d ago";
}

/**
 * Before the first briefing of the day runs there is no payload, but email triage may already have
 * produced suggested tasks. Rebuild rows from task metadata so the section is not blank all morning.
 */
function rowsFromSuggestedTasks(tasks: readonly TaskDto[]): readonly DisplayedActionRow[] {
  const displayed: DisplayedActionRow[] = [];
  for (const task of tasks) {
    const meta = task.suggestionMetadata;
    if (
      task.status !== "suggested" ||
      meta?.version !== 1 ||
      !meta.cacheMessageId?.trim() ||
      task.sourceRef === null ||
      task.sourceRef.length === 0
    )
      continue;
    displayed.push({
      liveStatus: "suggested",
      row: {
        taskId: task.id,
        title: task.title,
        explanation: task.description?.trim()
          ? task.description
          : "This email may need your attention.",
        category: meta.category,
        status: "suggested",
        primaryAction:
          meta.category === "needs_reply"
            ? { kind: "reply", cacheMessageId: meta.cacheMessageId }
            : meta.sourceHref?.trim()
              ? { kind: "view", href: meta.sourceHref }
              : null,
        source: task.source,
        sourceLabel: meta.sourceLabel,
        sourceRef: task.sourceRef ?? "",
        sourceHref: meta.sourceHref,
        dueAt: task.dueAt,
        computedAt: meta.computedAt,
        resurfaceReason: meta.resurfaceReason
      }
    });
  }
  return displayed;
}

/**
 * Reuses the briefing stale banner rather than `parseBriefingFreshness` — that parser reads run
 * source metadata, which is a different shape from an action row. Freshness is measured against the
 * run, so the pre-briefing fallback (no run) reports nothing.
 */
function buildFreshness(
  displayed: readonly DisplayedActionRow[],
  capturedAt: string | null
): SourceFreshnessV1 | null {
  if (!capturedAt || displayed.length === 0) return null;
  const oldestBySource = new Map<string, string>();
  for (const entry of displayed) {
    const current = oldestBySource.get(entry.row.source);
    if (!current || entry.row.computedAt < current) {
      oldestBySource.set(entry.row.source, entry.row.computedAt);
    }
  }
  return {
    version: 1,
    capturedAt,
    sources: [...oldestBySource].map(([source, asOf]) => ({
      source,
      freshnessKind: "connector_sync" as const,
      asOf
    }))
  };
}
