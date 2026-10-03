import { Button, NavIndex, NavIndexItem, Select } from "@moss/ui";
import { ChevronDown, Layers } from "lucide-react";
import { useRef, useState } from "react";

import { useDismissableMenu } from "../shared/use-dismissable-menu.js";
import { type ListState, primaryListSelection } from "./task-view-model";

const CUSTOM_VALUE = "__custom";

interface ListRef {
  readonly id: string;
  readonly name: string;
}

export interface TaskListNavigationProps {
  readonly lists: readonly ListRef[];
  readonly listStates: Readonly<Record<string, ListState>>;
  readonly soloIds: readonly string[];
  readonly counts: Record<string, number>;
  readonly allCount: number;
  readonly status: "loading" | "error" | "ready";
  readonly onRetry: () => void;
  /** Show only this list. */
  readonly onSelect: (id: string) => void;
  /** Cycle one list through include, solo and exclude. */
  readonly onCycle: (id: string) => void;
  readonly onReset: () => void;
}

function taskCount(n: number): string {
  return `${n} ${n === 1 ? "task" : "tasks"}`;
}

function customLabel(props: TaskListNavigationProps): string {
  const hidden = props.lists.filter((list) => props.listStates[list.id] === "excluded").length;
  if (props.soloIds.length > 1) return `${props.soloIds.length} lists shown`;
  return `${hidden} ${hidden === 1 ? "list" : "lists"} hidden`;
}

/** Desktop index beside the task surface. */
export function TaskListIndex(props: TaskListNavigationProps) {
  const selection = primaryListSelection(props.listStates);
  return (
    <NavIndex
      ariaLabel="Lists"
      label="Lists"
      footer={
        <>
          {selection.kind === "custom" ? (
            <p className="tasks-nav__note jds-caption" role="status">
              {customLabel(props)}
            </p>
          ) : null}
          <ListFilterMenu {...props} />
        </>
      }
    >
      <NavIndexItem
        label="All lists"
        count={props.status === "ready" ? props.allCount : undefined}
        ariaLabel={
          props.status === "ready" ? `All lists, ${taskCount(props.allCount)}` : "All lists"
        }
        selected={selection.kind === "all"}
        onSelect={props.onReset}
      />
      {props.lists.map((list) => {
        const count = props.counts[list.id] ?? 0;
        return (
          <NavIndexItem
            key={list.id}
            label={list.name}
            count={count}
            ariaLabel={`${list.name}, ${taskCount(count)}`}
            selected={selection.kind === "one" && selection.id === list.id}
            onSelect={() => props.onSelect(list.id)}
          />
        );
      })}
      <ListLoadState status={props.status} onRetry={props.onRetry} />
    </NavIndex>
  );
}

/** Compact list control for narrow widths, driven by the same state as the index. */
export function TaskListPicker(props: TaskListNavigationProps) {
  const selection = primaryListSelection(props.listStates);
  const value =
    selection.kind === "all" ? "" : selection.kind === "one" ? selection.id : CUSTOM_VALUE;
  return (
    <div className="tasks-picker">
      <Select
        aria-label="Show list"
        value={value}
        disabled={props.status !== "ready"}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") props.onReset();
          else if (next !== CUSTOM_VALUE) props.onSelect(next);
        }}
      >
        <option value="">
          {props.status === "loading"
            ? "Loading lists"
            : props.status === "error"
              ? "Lists unavailable"
              : `All lists (${props.allCount})`}
        </option>
        {props.lists.map((list) => (
          <option key={list.id} value={list.id}>
            {`${list.name} (${props.counts[list.id] ?? 0})`}
          </option>
        ))}
        {selection.kind === "custom" ? (
          <option value={CUSTOM_VALUE} disabled>
            {customLabel(props)}
          </option>
        ) : null}
      </Select>
      {props.status === "error" ? (
        <Button size="sm" variant="secondary" onClick={props.onRetry}>
          Retry
        </Button>
      ) : (
        <ListFilterMenu {...props} />
      )}
    </div>
  );
}

function ListLoadState(props: {
  readonly status: TaskListNavigationProps["status"];
  readonly onRetry: () => void;
}) {
  if (props.status === "loading") {
    return (
      <li className="tasks-nav__state jds-caption" role="status">
        Loading lists
      </li>
    );
  }
  if (props.status === "error") {
    return (
      <li className="tasks-nav__state jds-caption" role="alert">
        <span>Lists could not load.</span>
        <Button size="sm" variant="secondary" onClick={props.onRetry}>
          Retry
        </Button>
      </li>
    );
  }
  return null;
}

/** List filters: tri-state per list, include then solo (show only) then exclude (hide). */
function ListFilterMenu(props: TaskListNavigationProps) {
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

  const stateOf = (id: string): ListState => props.listStates[id] ?? "included";
  const anySolo = props.soloIds.length > 0;
  const clean = primaryListSelection(props.listStates).kind === "all";

  return (
    <div className="tk-listfilter" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className={`tk-listbtn ${open ? "is-open" : ""} ${!clean ? "is-on" : ""}`}
        aria-expanded={open}
        onClick={() => (open ? closeMenu() : setOpen(true))}
      >
        <Layers size={14} aria-hidden="true" />
        <span className="tk-listbtn__label">List filters</span>
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
            const st = stateOf(list.id);
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
