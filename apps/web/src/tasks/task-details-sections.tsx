import { Archive, ArrowUp, Check, ChevronDown, Circle, Plus, X } from "lucide-react";
import { useId, useState } from "react";

import type {
  LocaleSettingsDto,
  TaskActivityDto,
  TaskApiStatus,
  TaskDto,
  TaskTagDto
} from "@moss/shared";
import { Avatar, Button, Chip, EmptyState } from "@moss/ui";

import { formatDate, useUserLocale } from "../locale/locale-format";
import { useDismissableMenu } from "../shared/use-dismissable-menu.js";

export function AssignedPersonField(props: { readonly currentUserLabel: string }) {
  return (
    <div className="tk-peoplefield">
      <span className="tk-person">
        <Avatar name={props.currentUserLabel} size="xs" />
        <span className="tk-person__nm">
          {props.currentUserLabel}
          <span className="tk-person__me"> · you</span>
        </span>
      </span>
    </div>
  );
}

export function TaskTagsField(props: {
  readonly isNew: boolean;
  readonly newTags: readonly string[];
  readonly tags: readonly TaskTagDto[];
  readonly tagSuggestions: readonly TaskTagDto[];
  readonly draft: string;
  readonly onDraft: (value: string) => void;
  readonly onCommitDraft: () => void;
  readonly onAddSuggestion: (name: string) => void;
  readonly onRemoveNewTag: (name: string) => void;
  readonly onUnassignTag: (tagId: string) => void;
}) {
  const activeCount = props.isNew ? props.newTags.length : props.tags.length;
  return (
    <>
      <div className="tk-tagedit">
        {props.isNew
          ? props.newTags.map((name) => (
              <TagChip key={name} label={name} onRemove={() => props.onRemoveNewTag(name)} />
            ))
          : props.tags.map((tag) => (
              <TagChip key={tag.id} label={tag.name} onRemove={() => props.onUnassignTag(tag.id)} />
            ))}
        <input
          value={props.draft}
          aria-label="Add a tag"
          placeholder={activeCount ? "Add another…" : "Type a tag and press Enter"}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              props.onCommitDraft();
            }
          }}
        />
      </div>
      {props.tagSuggestions.length > 0 ? (
        <div className="tk-tagsugg">
          {props.tagSuggestions.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="tk-tagsugg__btn"
              onClick={() => props.onAddSuggestion(tag.name)}
            >
              #{tag.name}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function TagChip(props: { readonly label: string; readonly onRemove: () => void }) {
  return (
    <Chip onRemove={props.onRemove} removeLabel={`Remove ${props.label}`}>
      <span className="hash">#</span>
      {props.label}
    </Chip>
  );
}

export function TaskSubtasksField(props: {
  readonly isNew: boolean;
  readonly newSubs: readonly string[];
  readonly subs: readonly TaskDto[];
  readonly draft: string;
  readonly onNewSubChange: (index: number, value: string) => void;
  readonly onNewSubRemove: (index: number) => void;
  readonly onNewSubAdd: () => void;
  readonly onToggleExisting: (id: string, status: TaskApiStatus) => void;
  readonly onDraft: (value: string) => void;
  readonly onAddExisting: () => void;
}) {
  return (
    <div className="tk-subs">
      {props.isNew
        ? props.newSubs.map((text, index) => (
            <div className="tk-sub" key={index}>
              <span className="tk-sub__box" />
              <input
                value={text}
                placeholder="Subtask"
                onChange={(event) => props.onNewSubChange(index, event.target.value)}
              />
              <button
                type="button"
                className="tk-sub__rm"
                aria-label="Remove subtask"
                onClick={() => props.onNewSubRemove(index)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          ))
        : props.subs.map((sub) => (
            <div className={`tk-sub ${sub.status === "done" ? "tk-sub--done" : ""}`} key={sub.id}>
              <button
                type="button"
                className={`tk-sub__box ${sub.status === "done" ? "is-on" : ""}`}
                onClick={() =>
                  props.onToggleExisting(sub.id, sub.status === "done" ? "todo" : "done")
                }
                aria-label={sub.status === "done" ? `Reopen ${sub.title}` : `Complete ${sub.title}`}
              >
                {sub.status === "done" ? <Check size={12} aria-hidden="true" /> : null}
              </button>
              <input value={sub.title} readOnly />
            </div>
          ))}
      {props.isNew ? (
        <button type="button" className="tk-sub__add" onClick={props.onNewSubAdd}>
          <Plus size={15} aria-hidden="true" />
          Add subtask
        </button>
      ) : (
        <div className="tk-subadd">
          <input
            value={props.draft}
            placeholder="Add a subtask and press Enter"
            onChange={(event) => props.onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onAddExisting();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

export function TaskStatusControl(props: {
  readonly status: TaskApiStatus;
  readonly onChange: (status: TaskApiStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const closeMenu = () => {
    setOpen(false);
    document.getElementById(triggerId)?.focus();
  };
  const { ref } = useDismissableMenu<HTMLDivElement>({
    open,
    onClose: closeMenu
  });

  const done = props.status === "done";
  const archived = props.status === "archived";
  const mainLabel = done ? "Completed" : archived ? "Archived" : "Complete";
  const MainIcon = done ? Check : archived ? Archive : Circle;
  const mainClass = done ? "is-done" : archived ? "is-archived" : "";
  const items: {
    readonly label: string;
    readonly icon: typeof Circle;
    readonly status: TaskApiStatus;
  }[] = [];
  if (!archived) items.push({ label: "Archive", icon: Archive, status: "archived" });
  if (props.status !== "todo") items.push({ label: "Mark as open", icon: Circle, status: "todo" });

  return (
    <div className="tk-statusctl" ref={ref}>
      <Button
        icon={<MainIcon size={15} aria-hidden="true" />}
        variant={mainClass ? "secondary" : "quiet"}
        onClick={() => props.onChange(done || archived ? "todo" : "done")}
      >
        {mainLabel}
      </Button>
      <Button
        id={triggerId}
        aria-label="More status options"
        icon={<ChevronDown size={14} aria-hidden="true" />}
        variant="quiet"
        onClick={() => (open ? closeMenu() : setOpen(true))}
      />
      {open && items.length > 0 ? (
        <div className="tk-statusctl__menu tk-tagmenu">
          {items.map((item) => {
            const Ico = item.icon;
            return (
              <button
                key={item.status}
                type="button"
                className="tk-tagmenu__item"
                onClick={() => {
                  closeMenu();
                  props.onChange(item.status);
                }}
              >
                <Ico size={14} aria-hidden="true" />
                <span className="nm">{item.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TaskActivityPanel(props: {
  readonly entries: readonly TaskActivityDto[];
  readonly currentUserLabel: string;
  readonly draft: string;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly saveError: boolean;
  readonly onRetry: () => void;
  readonly onDraft: (value: string) => void;
  readonly onPost: () => void;
}) {
  const locale = useUserLocale();
  return (
    <div className="tk-activity">
      {props.loading ? (
        <p className="jds-hint" role="status">
          Loading activity…
        </p>
      ) : null}
      {props.loadError ? (
        <div className="tasks-notice" role="alert">
          <p className="jds-hint jds-hint--error">
            Could not load activity. Any previously loaded comments are still shown.
          </p>
          <Button size="sm" variant="secondary" onClick={props.onRetry}>
            Retry activity
          </Button>
        </div>
      ) : null}
      {props.entries.length > 0 ? (
        <div className="tk-act-list">
          {props.entries.map((entry) => (
            <div className="tk-act" key={entry.id}>
              <Avatar name={props.currentUserLabel} size="sm" />
              <div className="tk-act__body">
                <div className="tk-act__head">
                  <span className="tk-act__who">{props.currentUserLabel}</span>
                  <span className="tk-act__when">{relativeTime(entry.createdAt, locale)}</span>
                </div>
                <div className="tk-act__text">{entry.body ?? entry.activityType}</div>
              </div>
            </div>
          ))}
        </div>
      ) : !props.loading && !props.loadError ? (
        <EmptyState title="No activity yet. Log progress as you go." />
      ) : null}

      <div className="tk-act-composer">
        <textarea
          value={props.draft}
          rows={1}
          placeholder="Add a comment…"
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onPost();
            }
          }}
        />
        <Button
          disabled={!props.draft.trim() || props.pending}
          icon={<ArrowUp size={16} aria-hidden="true" />}
          variant="quiet"
          onClick={props.onPost}
          aria-label="Post comment"
        />
      </div>
      {props.saveError ? (
        <p className="jds-hint jds-hint--error" role="alert">
          Could not post your comment. Your text is still here; try again.
        </p>
      ) : null}
      <div className="tk-act-hint">Enter to post · Shift+Enter for a new line</div>
    </div>
  );
}

function relativeTime(iso: string | null, locale: LocaleSettingsDto): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return formatDate(iso, locale, { month: "short", day: "numeric" });
}
