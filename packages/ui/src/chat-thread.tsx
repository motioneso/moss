import { Fragment } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { BrandMark } from "./brand-mark.js";

import type {
  ChatRecordKind,
  SourceFreshnessEntry,
  SourceFreshnessV1,
  TranscriptRecord
} from "@moss/shared";

/**
 * The transcript thread, shared for real between the chat drawer, the assistant surface and
 * module windows (moved here from the web app's chat message-row so every surface renders the
 * same turns). Grouping, the Thinking peek and the status line live here; one row per record
 * renders through `renderRecord`. The shell's drawer and surface pass their full row (cards,
 * markdown, feedback, attachments); module threads use the built-in default, which covers the
 * plain turns a module feed carries (your bubbles, Moss replies, error and result lines) and
 * nothing else.
 */

export type ThreadRenderRecord = (record: TranscriptRecord, index: number) => ReactNode;

export function Thread(props: {
  readonly records: readonly TranscriptRecord[];
  /**
   * Whether a turn is still running. When given, a trailing step group only reads as
   * "Thinking..." while this is true; when omitted, a trailing group (no reply after it yet)
   * is treated as still in progress.
   */
  readonly working?: boolean;
  readonly renderRecord?: ThreadRenderRecord;
}) {
  const renderRecord = props.renderRecord ?? defaultRenderRecord;
  return (
    <div className="chatd-thread" aria-live="polite">
      {groupRecords(props.records, props.working).map((item, index) =>
        item.type === "activity" ? (
          <ActivityPeek
            key={`activity-${item.records[0]?.id ?? item.records[0]?.sequence ?? index}`}
            records={item.records}
            inProgress={item.inProgress}
          />
        ) : item.type === "status" ? (
          <StatusLine key={index} record={item.record} />
        ) : (
          <Fragment key={index}>{renderRecord(item.record, index)}</Fragment>
        )
      )}
    </div>
  );
}

const ACTIVITY_KINDS: ReadonlySet<ChatRecordKind> = new Set<ChatRecordKind>([
  "thinking",
  "thought",
  "tool",
  "result",
  "approval",
  "approved",
  "not_approved",
  "refusal",
  "refused",
  "status"
]);

type RenderItem =
  | { readonly type: "record"; readonly record: TranscriptRecord }
  | { readonly type: "status"; readonly record: TranscriptRecord }
  | {
      readonly type: "activity";
      readonly records: readonly TranscriptRecord[];
      readonly inProgress: boolean;
    };

/**
 * Status records ("I'll get today's top headlines for you.") surface in the thread as their own
 * quiet lines so it is obvious the assistant is working; thinking and tool steps collapse into
 * one "Thinking..." line per turn, placed after the statuses and just above the reply. The line
 * is never removed once the reply lands — it stays for historical context. Records come from the
 * persisted activity list as well as the live stream, so a restored conversation shows the same
 * steps as the turn did.
 */
export function groupRecords(
  records: readonly TranscriptRecord[],
  working?: boolean
): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: TranscriptRecord[] = [];

  const flush = (inProgress: boolean) => {
    if (buffer.length > 0) {
      items.push({ type: "activity", records: buffer, inProgress });
      buffer = [];
    }
  };

  for (const record of records) {
    if (record.kind === "status") {
      items.push({ type: "status", record });
    } else if (ACTIVITY_KINDS.has(record.kind)) {
      buffer.push(record);
    } else if (record.kind === "action_request" || record.kind === "action_result") {
      // Action notifications stay standalone, but their related activity remains one turn fold.
      // Keep collecting around the notification instead of flushing the fold at this boundary.
      items.push({ type: "record", record });
    } else {
      flush(false);
      items.push({ type: "record", record });
    }
  }
  flush(working ?? true);
  return items;
}

/** Note 2 — a status update shown inline in the thread, quieter than a reply bubble. */
function StatusLine(props: { readonly record: TranscriptRecord }) {
  return (
    <p className="chatd-status" role="status">
      {props.record.text}
    </p>
  );
}

export function ActivityPeek(props: {
  readonly records: readonly TranscriptRecord[];
  readonly inProgress?: boolean;
}) {
  const count = props.records.length;
  const inProgress = props.inProgress ?? false;
  return (
    <details className="chatd-peek chatd-peek--quiet" data-in-progress={inProgress || undefined}>
      <summary className="chatd-peek__summary chatd-peek__summary--quiet">
        <span className="chatd-peek__label">{inProgress ? "Thinking..." : "Thinking"}</span>
        {inProgress ? null : (
          <span className="chatd-peek__count">{`${count} ${count === 1 ? "step" : "steps"}`}</span>
        )}
        <ChevronDown className="chatd-peek__chev" size={12} aria-hidden="true" />
      </summary>
      <div className="chatd-peek__body">
        {props.records.map((record, index) => (
          <div className="chatd-peek__line" key={index}>
            <span className="chatd-peek__kind">{activityVerb(record)}</span>
            {record.text}
          </div>
        ))}
      </div>
    </details>
  );
}

export function activityVerb(record: TranscriptRecord): string {
  const labels: Partial<Record<ChatRecordKind, string>> = {
    thinking: "Thinking",
    thought: "Thought",
    tool: "Tool",
    result: "Result",
    approval: "Approval",
    approved: "Approved",
    not_approved: "Not approved",
    refusal: "Refusal",
    refused: "Refused"
  };
  const label = labels[record.kind];
  if (label) return label;
  if (record.kind === "action_result") {
    // #1661: "allowed" no longer implies unattended mode (a user's own approval reports it too,
    // because the gateway sees the grant and not the run), and "error" is not a denial — the
    // audit row for that event says the handler failed, which is a different thing from the user
    // or a policy refusing it.
    return record.outcome === "allowed"
      ? "Allowed"
      : record.outcome === "executed"
        ? "Executed"
        : record.outcome === "error"
          ? "Failed"
          : "Denied";
  }
  return `${record.kind} ·`;
}

/**
 * Allowlist URL sanitizer for every link the thread renderer produces — the same guarantee as
 * the shell's own message renderer. Only `http:`, `https:`, and `mailto:` survive; everything
 * else is dropped to an empty string. Chat content can echo fetched web content (indirect
 * prompt injection, #360), so this must stay intact.
 */
function safeThreadUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? url : "";
}

/**
 * Untrusted assistant text as GitHub-flavoured markdown. Security-critical, mirroring the
 * shell's renderer: raw HTML is NEVER rendered (no `rehype-raw`, no `dangerouslySetInnerHTML`,
 * so markup in the source is escaped), URLs pass through {@link safeThreadUrl}, and links open
 * in a new tab with a hardened `rel`.
 */
function ThreadMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="chatd-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeThreadUrl}
        components={{
          a: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => (
            <a {...rest} rel="noopener noreferrer" target="_blank" />
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The row a module thread renders for each record: your bubble on the right, a Moss bubble with
 * its markdown turned into formatting (issue 2375: the marks used to print literally), an error
 * line, or a quiet result line. The shell's own threads override this with their full row
 * (approval cards, provenance, feedback, attachments) — anything fancier than the turns below
 * falls through to a quiet line rather than rendering blank.
 */
function defaultRenderRecord(record: TranscriptRecord): ReactNode {
  if (record.kind === "user") {
    return (
      <div className="chatd-msg chatd-msg--me">
        {record.text ? <div className="chatd-bubble">{record.text}</div> : null}
      </div>
    );
  }
  if (record.kind === "reply") {
    return (
      <div className="chatd-msg">
        <span className="chatd-msg__av">
          <BrandMark size={14} />
        </span>
        <div className="chatd-bubble">
          <ThreadMarkdown text={record.text} />
        </div>
        <ChatFreshnessFooter sourceFreshness={record.sourceFreshness} />
      </div>
    );
  }
  if (record.kind === "error") {
    return <p className="form-error">{record.text}</p>;
  }
  return (
    <div className="chatd-peek__line" role="status">
      <span className="chatd-peek__kind">{activityVerb(record)}</span>
      {record.text}
    </div>
  );
}

function chatFreshnessLabel(entry: SourceFreshnessEntry, capturedAt: string): string {
  if (entry.freshnessKind === "realtime") return "live";
  if (!entry.asOf) return "unknown";
  const ageMs = new Date(capturedAt).getTime() - new Date(entry.asOf).getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

const CHAT_SOURCE_LABEL: Record<string, string> = {
  email: "Email",
  calendar: "Calendar",
  vault: "Notes",
  tasks: "Tasks",
  commitments: "Commitments",
  chats: "Chats",
  goals: "Goals"
};

export function ChatFreshnessFooter({
  sourceFreshness
}: {
  readonly sourceFreshness?: SourceFreshnessV1 | null;
}) {
  if (!sourceFreshness) return null;
  const summaryNames = sourceFreshness.sources
    .map((e) => CHAT_SOURCE_LABEL[e.source] ?? e.source)
    .join(", ");
  return (
    <details className="chatd-freshness chatd-peek">
      <summary className="chatd-peek__summary">
        <span className="chatd-peek__label">Sources</span>
        <span className="chatd-peek__count">{summaryNames}</span>
        <svg
          className="chatd-peek__chev"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <ul className="chatd-freshness__list chatd-peek__body">
        {sourceFreshness.sources.map((entry) => (
          <li key={entry.source} className="chatd-freshness__item chatd-peek__line">
            <span className="chatd-freshness__source">
              {CHAT_SOURCE_LABEL[entry.source] ?? entry.source}
            </span>
            <span className="chatd-freshness__age" title={entry.asOf ?? undefined}>
              {chatFreshnessLabel(entry, sourceFreshness.capturedAt)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
