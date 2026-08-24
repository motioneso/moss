import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskDefaultView, TaskDto, TaskSearchIntent } from "@moss/shared";
import { Chip, EmptyState, Segmented } from "@moss/ui";
import {
  CheckCheck,
  ChevronDown,
  Layers,
  LoaderCircle,
  Search,
  GitCommitHorizontal,
  Tag
} from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import {
  getTaskPreferences,
  interpretTaskSearch,
  listTaskLists,
  listTasks,
  updateTask,
  updateTaskPreferences
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useUserLocale } from "../locale/locale-format";
import { useDismissableMenu } from "../shared/use-dismissable-menu.js";
import { FOCUS_LABELS, isTaskFocus } from "./focus";
import { TaskCapture } from "./task-capture";
import { TaskDetailsDialog } from "./task-details-dialog";
import { TaskListView } from "./task-list-view";
import { TaskMatrixView } from "./task-matrix-view";
import { statusLabels } from "./task-format";
import {
  deriveTaskFilters,
  statusFilters,
  type ListState,
  type StatusFilter
} from "./task-view-model";
import "../styles/kit-tasks.css";
import "../styles/kit-tasks-modal.css";
import "./tasks.css";

export function TasksPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusParam = searchParams.get("focus");
  const focus = isTaskFocus(focusParam) ? focusParam : null;
  const clearFocus = () =>
    setSearchParams(
      (prev) => {
        prev.delete("focus");
        return prev;
      },
      { replace: true }
    );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todo");
  const [search, setSearch] = useState("");
  const [searchIntent, setSearchIntent] = useState<TaskSearchIntent | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
  const [listStates, setListStates] = useState<Record<string, ListState>>({});
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  // Modal: null = closed; { id: string } = edit; { id: null, defaultName? } = create.
  const [dialog, setDialog] = useState<{
    readonly id: string | null;
    readonly defaultName?: string;
  } | null>(null);

  const tasksQuery = useQuery({ queryKey: queryKeys.tasks.list, queryFn: () => listTasks() });
  const listsQuery = useQuery({ queryKey: queryKeys.tasks.lists, queryFn: listTaskLists });
  const prefsQuery = useQuery({
    queryKey: queryKeys.tasks.preferences,
    queryFn: getTaskPreferences
  });

  const locale = useUserLocale();
  const view: TaskDefaultView = prefsQuery.data?.preferences.defaultView ?? "priority";
  const lists = listsQuery.data?.lists ?? [];
  const allTasks = tasksQuery.data?.tasks ?? [];
  const deferredSearch = useDeferredValue(search);

  const viewMutation = useMutation({
    mutationFn: (next: TaskDefaultView) => updateTaskPreferences({ defaultView: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.preferences });
    }
  });

  const updateMutation = useMutation({
    mutationFn: (task: TaskDto) =>
      updateTask(task.id, { status: task.status === "done" ? "todo" : "done" }),
    onSuccess: () => {
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
      }, 500);
    }
  });

  // Suggested-task review (#729): accept promotes to todo, dismiss archives.
  const triageMutation = useMutation({
    mutationFn: (input: { readonly task: TaskDto; readonly status: "todo" | "archived" }) =>
      updateTask(input.task.id, { status: input.status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list });
    }
  });

  const interpretMutation = useMutation({
    mutationFn: (query: string) => interpretTaskSearch({ query }),
    onSuccess: (response) => {
      const nextIntent = intentForUi(response.intent);
      if (response.intent.status) {
        setStatusFilter(response.intent.status);
        clearFocus();
      }
      setSearchIntent(hasStructuredIntent(nextIntent) ? nextIntent : null);
      setSearchWarning(
        response.warnings[0] ??
          (hasStructuredIntent(nextIntent) ? null : "No structured filter found.")
      );
    },
    onError: () => {
      setSearchIntent(null);
      setSearchWarning("Natural-language filtering is unavailable.");
    }
  });

  const derived = useMemo(
    () =>
      deriveTaskFilters({
        tasks: allTasks,
        lists,
        statusFilter,
        focus,
        listStates,
        tagFilter,
        search: deferredSearch,
        searchIntent,
        timeZone: locale.timezone
      }),
    [
      allTasks,
      deferredSearch,
      focus,
      listStates,
      lists,
      statusFilter,
      tagFilter,
      searchIntent,
      locale.timezone
    ]
  );
  const { allTags, listCounts, listCountTotal, soloIds, visibleTasks } = derived;
  const stateOf = (listId: string): ListState => listStates[listId] ?? "included";
  const listNames = useMemo(() => new Map(lists.map((list) => [list.id, list.name])), [lists]);
  const searchChips = searchIntent ? taskSearchChips(searchIntent, listNames) : [];

  const cycleList = (id: string) =>
    setListStates((s) => {
      const cur = s[id] ?? "included";
      const next: ListState =
        cur === "included" ? "solo" : cur === "solo" ? "excluded" : "included";
      return { ...s, [id]: next };
    });
  const submitSearchIntent = () => {
    const query = search.trim();
    if (!query) return;
    interpretMutation.mutate(query);
  };

  return (
    <section className="tasks-wrap tasks--comfortable tasks--panels" aria-label="Tasks">
      <div className="tk-bar">
        <div className="tk-bar__left">
          <div className="tk-bar__r1">
            <ListFilterMenu
              lists={lists}
              stateOf={stateOf}
              soloIds={soloIds}
              counts={listCounts}
              allCount={listCountTotal}
              onCycle={cycleList}
              onReset={() => setListStates({})}
            />

            <Segmented<TaskDefaultView>
              ariaLabel="View"
              options={[
                { value: "priority", label: "List" },
                { value: "matrix", label: "Matrix" }
              ]}
              value={view}
              onChange={(next) => {
                if (viewMutation.isPending) return;
                viewMutation.mutate(next);
              }}
            />
          </div>

          {/* "" is the no-selection value: a URL focus overrides the status filter. */}
          <Segmented<StatusFilter | "">
            ariaLabel="Status filter"
            options={statusFilters.map((status) => ({
              value: status,
              label: status === "all" ? "All" : statusLabels[status]
            }))}
            value={focus ? "" : statusFilter}
            onChange={(next) => {
              if (next === "") return;
              setStatusFilter(next);
              clearFocus();
            }}
          />

          <span className="tk-bar__sep" />

          <TagFilter
            all={allTags}
            active={tagFilter}
            onAdd={(name) => setTagFilter((a) => (a.includes(name) ? a : [...a, name]))}
          />
        </div>

        <div className="tk-bar__right">
          <div className={`tk-bar__search${showSearch ? " is-open" : ""}`}>
            <label className="tk-tagfield">
              <span className="ic">
                <Search size={14} aria-hidden="true" />
              </span>
              <input
                aria-label="Search tasks"
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSearchIntent(null);
                  setSearchWarning(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  submitSearchIntent();
                }}
                placeholder="Search tasks…"
                type="search"
                value={search}
              />
              <button
                aria-label="Interpret search"
                className="tk-tagfield__action"
                disabled={interpretMutation.isPending || !search.trim()}
                onClick={submitSearchIntent}
                type="button"
              >
                <GitCommitHorizontal size={14} aria-hidden="true" />
              </button>
            </label>
          </div>

          <button
            aria-label="Toggle search"
            className={`tk-msrch${showSearch ? " is-active" : ""}`}
            type="button"
            onClick={() => setShowSearch((v) => !v)}
          >
            <Search size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {focus ? (
        <div className="tk-activetags">
          <span className="tk-activetags__lbl">Focus</span>
          <Chip removeLabel="Clear focus" onRemove={clearFocus}>
            {FOCUS_LABELS[focus]}
          </Chip>
        </div>
      ) : null}

      {tagFilter.length > 0 ? (
        <div className="tk-activetags">
          <span className="tk-activetags__lbl">Tags</span>
          {tagFilter.map((name) => (
            <Chip
              key={name}
              removeLabel={`Remove ${name}`}
              onRemove={() => setTagFilter((a) => a.filter((x) => x !== name))}
            >
              <span className="hash">#</span>
              {name}
            </Chip>
          ))}
          <button type="button" className="tk-activetags__clear" onClick={() => setTagFilter([])}>
            Clear
          </button>
        </div>
      ) : null}

      {searchChips.length > 0 || searchWarning ? (
        <div className="tk-activetags">
          <span className="tk-activetags__lbl">Search</span>
          {searchChips.map((chip) => (
            <Chip
              key={chip.key}
              removeLabel={`Remove ${chip.label}`}
              onRemove={() => setSearchIntent((intent) => removeSearchIntentChip(intent, chip.key))}
            >
              {chip.label}
            </Chip>
          ))}
          {searchWarning ? <span className="tk-activetags__note">{searchWarning}</span> : null}
          {searchChips.length > 0 ? (
            <button
              type="button"
              className="tk-activetags__clear"
              onClick={() => setSearchIntent(null)}
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      <TaskCapture
        defaultListId={soloIds.length === 1 ? soloIds[0] : undefined}
        onDetails={(name) => setDialog({ id: null, defaultName: name })}
      />

      {tasksQuery.isLoading ? (
        <EmptyState
          icon={<LoaderCircle className="spin" size={24} aria-hidden="true" />}
          title="Loading tasks"
        />
      ) : visibleTasks.length === 0 ? (
        <EmptyState
          icon={<CheckCheck size={24} aria-hidden="true" />}
          title="No tasks match"
          description="Try clearing a filter or two."
        />
      ) : view === "matrix" ? (
        <TaskMatrixView
          tasks={visibleTasks}
          lists={lists}
          isUpdating={updateMutation.isPending}
          onToggleDone={(task) => updateMutation.mutate(task)}
          onOpen={(task) => setDialog({ id: task.id })}
        />
      ) : (
        <TaskListView
          tasks={visibleTasks}
          lists={lists}
          isUpdating={updateMutation.isPending || triageMutation.isPending}
          onToggleDone={(task) => updateMutation.mutate(task)}
          onOpen={(task) => setDialog({ id: task.id })}
          onAccept={(task) => triageMutation.mutate({ task, status: "todo" })}
          onDismiss={(task) => triageMutation.mutate({ task, status: "archived" })}
        />
      )}

      {dialog ? (
        <TaskDetailsDialog
          open
          taskId={dialog.id}
          defaultListId={soloIds.length === 1 ? soloIds[0] : lists[0]?.id}
          defaultTitle={dialog.defaultName}
          currentUserLabel="You"
          lists={lists}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

type SearchChipKey =
  | "text"
  | "effort"
  | "priority"
  | "quadrant"
  | "due"
  | `list:${string}`
  | `tag:${string}`;

function intentForUi(intent: TaskSearchIntent): TaskSearchIntent {
  return { ...intent, status: null };
}

function hasStructuredIntent(intent: TaskSearchIntent): boolean {
  return (
    Boolean(intent.text) ||
    intent.effort !== null ||
    intent.priority !== null ||
    intent.listIds.length > 0 ||
    intent.tagNames.length > 0 ||
    intent.quadrant !== null ||
    intent.due !== null
  );
}

function taskSearchChips(
  intent: TaskSearchIntent,
  listNames: ReadonlyMap<string, string>
): readonly { readonly key: SearchChipKey; readonly label: string }[] {
  return [
    ...(intent.text ? [{ key: "text" as const, label: `Text: ${intent.text}` }] : []),
    ...(intent.effort ? [{ key: "effort" as const, label: `Effort: ${intent.effort}` }] : []),
    ...(intent.priority !== null
      ? [{ key: "priority" as const, label: `Priority: ${intent.priority}` }]
      : []),
    ...(intent.quadrant
      ? [{ key: "quadrant" as const, label: `Quadrant: ${intent.quadrant}` }]
      : []),
    ...(intent.due ? [{ key: "due" as const, label: dueIntentLabel(intent.due) }] : []),
    ...intent.listIds.map((id) => ({
      key: `list:${id}` as const,
      label: `List: ${listNames.get(id) ?? id}`
    })),
    ...intent.tagNames.map((name) => ({ key: `tag:${name}` as const, label: `#${name}` }))
  ];
}

function removeSearchIntentChip(
  intent: TaskSearchIntent | null,
  key: SearchChipKey
): TaskSearchIntent | null {
  if (!intent) return null;
  const next =
    key === "effort"
      ? { ...intent, effort: null }
      : key === "text"
        ? { ...intent, text: null }
        : key === "priority"
          ? { ...intent, priority: null }
          : key === "quadrant"
            ? { ...intent, quadrant: null }
            : key === "due"
              ? { ...intent, due: null }
              : key.startsWith("list:")
                ? { ...intent, listIds: intent.listIds.filter((id) => id !== key.slice(5)) }
                : { ...intent, tagNames: intent.tagNames.filter((name) => name !== key.slice(4)) };
  return hasStructuredIntent(next) ? next : null;
}

function dueIntentLabel(due: NonNullable<TaskSearchIntent["due"]>): string {
  if (due.kind === "none") return "No due date";
  if (due.kind === "overdue") return "Due: overdue";
  if (due.kind === "today") return "Due: today";
  if (due.kind === "this_week") return "Due: this week";
  if (due.dueAfter && due.dueBefore) return `Due: ${due.dueAfter} to ${due.dueBefore}`;
  if (due.dueAfter) return `Due after: ${due.dueAfter}`;
  if (due.dueBefore) return `Due before: ${due.dueBefore}`;
  return "Due date";
}

/** Lists filter — tri-state per list: include → solo (focus, dim others) → exclude (hide). */
function ListFilterMenu(props: {
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly stateOf: (id: string) => ListState;
  readonly soloIds: readonly string[];
  readonly counts: Record<string, number>;
  readonly allCount: number;
  readonly onCycle: (id: string) => void;
  readonly onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const { ref } = useDismissableMenu<HTMLDivElement>({
    open,
    onClose: closeMenu
  });

  const excluded = props.lists.filter((list) => props.stateOf(list.id) === "excluded");
  const anySolo = props.soloIds.length > 0;
  const clean = !anySolo && excluded.length === 0;
  const soloed = props.lists.filter((list) => props.stateOf(list.id) === "solo");

  let label = "All lists";
  let hidden = 0;
  if (soloed.length === 1) label = soloed[0]?.name ?? "All lists";
  else if (soloed.length > 1) label = `${soloed.length} lists`;
  else if (excluded.length) hidden = excluded.length;

  return (
    <div className="tk-listfilter" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className={`tk-listbtn ${open ? "is-open" : ""} ${!clean ? "is-on" : ""}`}
        onClick={() => (open ? closeMenu() : setOpen(true))}
      >
        <Layers size={14} aria-hidden="true" />
        {label}
        {hidden ? <span className="tk-listbtn__hidden"> · {hidden} hidden</span> : null}
        <span className="tk-listbtn__chev">
          <ChevronDown size={14} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="tk-tagmenu" style={{ minWidth: 234 }}>
          <button
            type="button"
            className={`tk-tagmenu__item ${clean ? "is-active" : ""}`}
            onClick={props.onReset}
          >
            <Layers size={14} aria-hidden="true" />
            <span className="nm">All lists</span>
            <span className="ct">{props.allCount}</span>
          </button>
          <div className="tk-tagmenu__hd">Your lists</div>
          {props.lists.map((list) => {
            const st = props.stateOf(list.id);
            const cls =
              st === "solo"
                ? "is-solo"
                : st === "excluded"
                  ? "is-excluded"
                  : anySolo
                    ? "is-dim"
                    : "";
            return (
              <button
                key={list.id}
                type="button"
                className={`tk-tagmenu__item ${cls}`}
                onClick={() => props.onCycle(list.id)}
              >
                <span className="tk-listbtn__dot" />
                <span className="nm">{list.name}</span>
                {st === "solo" ? (
                  <span className="tk-liststate tk-liststate--only">Only</span>
                ) : st === "excluded" ? (
                  <span className="tk-liststate tk-liststate--hidden">Hidden</span>
                ) : null}
                <span className="ct">{props.counts[list.id] ?? 0}</span>
              </button>
            );
          })}
          <div className="tk-tagmenu__hint">
            Click to focus a list · again to hide it · again to reset
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Tag filter — type to narrow, pick to add (OR across selected tags). */
function TagFilter(props: {
  readonly all: readonly string[];
  readonly active: readonly string[];
  readonly onAdd: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const matches = props.all.filter(
    (name) => !props.active.includes(name) && name.includes(query.trim().toLowerCase())
  );

  const pick = (name: string) => {
    props.onAdd(name);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="tk-tagfilter">
      <div className="tk-tagfield">
        <span className="ic">
          <Tag size={14} aria-hidden="true" />
        </span>
        <input
          value={query}
          placeholder="Filter by tag…"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches.length) {
              event.preventDefault();
              pick(matches[0] ?? "");
            }
          }}
        />
      </div>
      {open ? (
        <div className="tk-tagmenu">
          <div className="tk-tagmenu__hd">{query ? "Matching tags" : "All tags"}</div>
          {matches.length ? (
            matches.map((name) => (
              <button
                key={name}
                type="button"
                className="tk-tagmenu__item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(name)}
              >
                <span className="hash">#</span>
                {name}
              </button>
            ))
          ) : (
            <div className="tk-tagmenu__empty">No more tags{query ? ` for “${query}”` : ""}.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
