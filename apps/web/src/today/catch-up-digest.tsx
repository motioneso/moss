import { Badge, Button, IconButton, InfoTip, RowIndex, RowIndexItem } from "@moss/ui";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useRef, useState } from "react";

import type { BriefingCatchUpDto, LocaleSettingsDto } from "@moss/shared";

import { createTask, updateTask } from "../api/client";
import { queryKeys } from "../api/query-keys";
import {
  createUsefulnessFeedback,
  undoUsefulnessFeedback
} from "../api/usefulness-feedback-client";
import { formatDate, formatTime } from "../locale/locale-format";

import { buildReplyChatPrompt } from "./briefing-reply-prompt";

export type CatchUpDigestReason = "waiting_on_them" | "important" | null;
export type CatchUpDigestStatus = "open" | "added" | "dismissed";

export interface CatchUpDigestEntry {
  readonly id: string;
  readonly senderName: string;
  readonly summary: string;
  readonly receivedLabel: string;
  readonly reason: CatchUpDigestReason;
  readonly canReply: boolean;

  /** Provider deep link supplied by the host; absent for mail with no web view (IMAP). */
  readonly openHref: string | null;
}

export interface CatchUpDigestProps {
  readonly entries: readonly CatchUpDigestEntry[];
  readonly sinceLabel: string;
  readonly leftOutCount: number;
  readonly statusById: Readonly<Record<string, CatchUpDigestStatus>>;
  readonly chatAvailable: boolean;
  readonly error: string | null;
  readonly onReply: (id: string) => void;
  readonly onAddTask: (id: string) => void;
  readonly onDismiss: (id: string) => void;
  readonly onUndo: (id: string) => void;
}

const VISIBLE_LIMIT = 5;

const REASON_LABEL: Record<NonNullable<CatchUpDigestReason>, string> = {
  waiting_on_them: "Waiting on them",
  important: "Important"
};

export function CatchUpDigest(props: CatchUpDigestProps) {
  const [expanded, setExpanded] = useState(false);
  if (props.entries.length === 0) return null;

  const visible = expanded ? props.entries : props.entries.slice(0, VISIBLE_LIMIT);
  const hiddenCount = props.entries.length - visible.length;
  const countLabel = `${props.entries.length} ${props.entries.length === 1 ? "email" : "emails"} ${props.sinceLabel}`;

  return (
    <div className="briefing-catchup">
      <div className="briefing-catchup__head">
        <span className="jds-brief__kicker">Catch-up</span>
        <span className="jds-caption">{countLabel}</span>
        <InfoTip label="Why these emails?">
          Mail from people, replies you are waiting on, and anything marked important. Newsletters,
          receipts, notifications and sign-in codes stay out. Mail that needs a reply or a task
          shows up above instead.
        </InfoTip>
      </div>
      <RowIndex density="compact">
        {visible.map((entry) => (
          <RowIndexItem
            key={entry.id}
            title={
              <span className="briefing-catchup__sender">
                <span>{entry.senderName}</span>
                {entry.reason ? (
                  <Badge tone={entry.reason === "important" ? "amber" : "neutral"}>
                    {REASON_LABEL[entry.reason]}
                  </Badge>
                ) : null}
              </span>
            }
            excerpt={entry.summary}
            meta={
              <EntryMeta entry={entry} status={props.statusById[entry.id] ?? "open"} {...props} />
            }
          />
        ))}
      </RowIndex>
      <div className="briefing-catchup__foot">
        {hiddenCount > 0 ? (
          <Button size="sm" variant="link" onClick={() => setExpanded(true)}>
            Show {hiddenCount} more
          </Button>
        ) : null}
        {props.leftOutCount > 0 ? (
          <span className="jds-caption">
            Left out {props.leftOutCount} newsletters, receipts and notifications.
          </span>
        ) : null}
        {props.error ? (
          <span className="jds-caption" role="alert">
            {props.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function EntryMeta(
  props: CatchUpDigestProps & {
    readonly entry: CatchUpDigestEntry;
    readonly status: CatchUpDigestStatus;
  }
) {
  const { entry, status } = props;
  if (status !== "open") {
    return (
      <>
        <span className="jds-caption">
          {status === "added" ? "Added to your tasks" : "Dismissed"}
        </span>
        <Button size="sm" variant="link" onClick={() => props.onUndo(entry.id)}>
          Undo
        </Button>
      </>
    );
  }
  return (
    <>
      <span className="jds-caption">{entry.receivedLabel}</span>
      {entry.openHref ? (
        <a
          className="jds-btn jds-btn--sm jds-btn--quiet"
          href={entry.openHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open
        </a>
      ) : null}
      {entry.canReply ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={!props.chatAvailable}
          title={props.chatAvailable ? undefined : "Chat is unavailable right now."}
          onClick={() => props.onReply(entry.id)}
        >
          Reply
        </Button>
      ) : null}
      <Button size="sm" variant="quiet" onClick={() => props.onAddTask(entry.id)}>
        Add task
      </Button>
      <IconButton
        size="sm"
        aria-label={`Dismiss email from ${entry.senderName}`}
        title="Dismiss"
        onClick={() => props.onDismiss(entry.id)}
      >
        <X size={14} aria-hidden="true" />
      </IconButton>
    </>
  );
}

interface HandledRecord {
  readonly feedbackId: string;
  readonly taskId: string | null;
}

const ACTION_FAILED = "That did not save. Try again.";

/** Today's catch-up digest bound to a briefing run's payload and the feedback and task APIs. */
export function BriefingCatchUp(props: {
  readonly catchUp: BriefingCatchUpDto;
  readonly locale: LocaleSettingsDto;
  readonly chatAvailable: boolean;
  readonly onOpenChat: (prompt: string) => void;
  readonly now?: Date;
}) {
  const queryClient = useQueryClient();
  const [statusById, setStatusById] = useState<Record<string, CatchUpDigestStatus>>({});
  const [error, setError] = useState<string | null>(null);

  // Each handled entry keeps the promise of its saved feedback, so Undo works mid-save.
  const handled = useRef(new Map<string, Promise<HandledRecord>>());
  const now = props.now ?? new Date();
  const byId = new Map(props.catchUp.entries.map((entry) => [entry.id, entry]));
  const setStatus = (id: string, status: CatchUpDigestStatus) =>
    setStatusById((current) => ({ ...current, [id]: status }));

  const recordFeedback = async (id: string, kind: "dismiss" | "more_like_this") =>
    (
      await createUsefulnessFeedback({
        targetKind: "briefing_item",
        targetRef: id,
        surface: "briefing",
        kind
      })
    ).feedback.id;

  const act = (id: string, status: CatchUpDigestStatus, work: () => Promise<HandledRecord>) => {
    setError(null);
    setStatus(id, status);
    const pending = work();
    handled.current.set(id, pending);
    pending.catch(() => {
      if (handled.current.get(id) !== pending) return;
      handled.current.delete(id);
      setStatus(id, "open");
      setError(ACTION_FAILED);
    });
  };

  const addTask = (id: string) => {
    const entry = byId.get(id);
    if (!entry) return;
    act(id, "added", async () => {
      const { task } = await createTask({
        title: `Follow up with ${entry.senderName}`,
        description: entry.summary
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
      try {
        return { feedbackId: await recordFeedback(id, "more_like_this"), taskId: task.id };
      } catch (cause) {
        await updateTask(task.id, { status: "archived" }).catch(() => undefined);
        throw cause;
      }
    });
  };

  const undo = (id: string) => {
    const pending = handled.current.get(id);
    if (!pending) return;
    const previous = statusById[id] ?? "open";
    handled.current.delete(id);
    setError(null);
    setStatus(id, "open");
    void pending
      .then(async (record) => {
        await undoUsefulnessFeedback(record.feedbackId);
        if (record.taskId) {
          await updateTask(record.taskId, { status: "archived" });
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
        }
      })
      .catch(() => {
        handled.current.set(id, pending);
        setStatus(id, previous);
        setError(ACTION_FAILED);
      });
  };

  return (
    <CatchUpDigest
      entries={props.catchUp.entries.map((entry) => ({
        id: entry.id,
        senderName: entry.senderName,
        summary: entry.summary,
        receivedLabel: receivedLabel(entry.receivedAt, props.locale, now),
        reason: entry.reason,
        canReply: entry.cacheMessageId !== null,
        openHref: entry.openHref
      }))}
      sinceLabel={sinceLabel(props.catchUp.since, props.locale, now)}
      leftOutCount={props.catchUp.leftOutCount}
      statusById={statusById}
      chatAvailable={props.chatAvailable}
      error={error}
      onReply={(id) => {
        const cacheMessageId = byId.get(id)?.cacheMessageId;
        if (cacheMessageId) props.onOpenChat(buildReplyChatPrompt(cacheMessageId));
      }}
      onAddTask={addTask}
      onDismiss={(id) =>
        act(id, "dismissed", async () => ({
          feedbackId: await recordFeedback(id, "dismiss"),
          taskId: null
        }))
      }
      onUndo={undo}
    />
  );
}

const DAY_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };

function sameLocalDay(a: string | Date, b: Date, locale: LocaleSettingsDto): boolean {
  return formatDate(a, locale, DAY_OPTS) === formatDate(b, locale, DAY_OPTS);
}

function receivedLabel(receivedAt: string, locale: LocaleSettingsDto, now: Date): string {
  if (sameLocalDay(receivedAt, now, locale)) return formatTime(receivedAt, locale);
  return `${formatDate(receivedAt, locale, { weekday: "short" })} ${formatTime(receivedAt, locale)}`;
}

function sinceLabel(since: string | null, locale: LocaleSettingsDto, now: Date): string {
  return since === null ? "today" : `since ${receivedLabel(since, locale, now)}`;
}
