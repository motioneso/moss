import { MessageSquareText } from "lucide-react";
import { EmptyState as JdsEmptyState } from "@moss/ui";
import type { LocaleSettingsDto } from "@moss/shared";
import { formatDate, useUserLocale } from "../locale/locale-format";
export function HistoryList(props: {
  readonly threads: readonly {
    readonly id: string;
    readonly title: string;
    readonly lastActiveAt: string;
    readonly lastMessagePreview: string | null;
  }[];
  readonly selectedThreadId: string | null;
  readonly onSelect: (threadId: string) => void;
  readonly activating: boolean;
}) {
  const locale = useUserLocale();
  if (props.threads.length === 0) {
    return (
      <div className="chatd-sess chatd-sess--empty">
        <JdsEmptyState
          icon={<MessageSquareText size={18} aria-hidden="true" />}
          title="No past conversations yet."
        />
      </div>
    );
  }
  return (
    <div className="chatd-sess">
      <div className="chatd-sess__hd">History</div>
      {props.threads.map((thread) => (
        <button
          className={`chatd-sess__row${props.selectedThreadId === thread.id ? " is-selected" : ""}`}
          disabled={props.activating}
          key={thread.id}
          type="button"
          onClick={() => props.onSelect(thread.id)}
        >
          <span className="chatd-sess__ic">
            <MessageSquareText size={14} aria-hidden="true" />
          </span>
          <span className="chatd-sess__main">
            <span className="chatd-sess__title">{thread.title}</span>
            {thread.lastMessagePreview ? (
              <span className="chatd-sess__preview">{thread.lastMessagePreview}</span>
            ) : null}
          </span>
          <span className="chatd-sess__when">
            {relativeThreadTime(thread.lastActiveAt, locale)}
          </span>
        </button>
      ))}
    </div>
  );
}

function relativeThreadTime(value: string, locale: LocaleSettingsDto): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return formatDate(value, locale, { month: "short", day: "numeric" });
}
