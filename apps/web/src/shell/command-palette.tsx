import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListTaskListsResponse, TaskListDto } from "@moss/shared";
import { AlertCircle, Check, Layers3, Search } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { createTask, listTaskLists, setActiveTheme, setColorMode } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAssistantName } from "../api/use-assistant-name.js";
import {
  buildCommandPaletteCommands,
  type CommandPaletteCommand,
  type CommandPaletteGroup,
  filterCommandPaletteCommands
} from "./command-palette-model.js";
import { NAV_ICON_MAP } from "./nav-icons.js";
import type { ListThemesResponse, ModuleDto } from "@moss/shared";

type Stage =
  | { readonly kind: "root" }
  | { readonly kind: "pick-list" }
  | { readonly kind: "enter-title"; readonly list: TaskListChoice };

type PaletteItem = CommandPaletteCommand | ListItem;
type PaletteGroup = CommandPaletteGroup | ListGroup;

interface TaskListChoice {
  readonly id: string | null;
  readonly name: string;
}

interface PaletteToast {
  readonly id: number;
  readonly message: string;
  readonly tone: "ready" | "error";
}

export function CommandPalette(props: {
  readonly modules: readonly ModuleDto[];
  readonly disabledModuleIds: readonly string[];
  readonly themes: ListThemesResponse | undefined;
  readonly navigate: (to: string) => void;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const assistantName = useAssistantName();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "root" });
  const [query, setQuery] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [toasts, setToasts] = useState<readonly PaletteToast[]>([]);
  const nextToastId = useRef(1);
  const listsQuery = useQuery<ListTaskListsResponse>({
    queryKey: queryKeys.tasks.lists,
    queryFn: listTaskLists,
    enabled: open
  });
  const commands = useMemo(
    () =>
      buildCommandPaletteCommands({
        modules: props.modules,
        disabledModuleIds: props.disabledModuleIds,
        themes: props.themes,
        assistantName
      }),
    [props.disabledModuleIds, props.modules, props.themes, assistantName]
  );
  const groups = useMemo<readonly PaletteGroup[]>(() => {
    if (stage.kind === "root") return filterCommandPaletteCommands(commands, query);
    if (stage.kind === "pick-list")
      return listGroups(taskChoices(listsQuery.data?.lists ?? []), query);
    return titleGroups(stage.list, taskTitle);
  }, [commands, listsQuery.data?.lists, query, stage, taskTitle]);
  const items = useMemo<readonly PaletteItem[]>(
    () => groups.flatMap((group) => [...group.items]),
    [groups]
  );

  const closePalette = useCallback(() => {
    setOpen(false);
    setStage({ kind: "root" });
    setQuery("");
    setTaskTitle("");
    setActiveIndex(0);
    restorePaletteFocus(lastFocusedRef.current);
  }, []);

  const showToast = useCallback((message: string, tone: "ready" | "error" = "ready") => {
    const id = nextToastId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 2900);
  }, []);

  const openPalette = useCallback(() => {
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);

  const themeMutation = useMutation({
    mutationFn: (themeId: string) => setActiveTheme({ id: themeId }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.themes, data);
      showToast("Theme updated");
      closePalette();
    },
    onError: (error) => showToast(error.message, "error")
  });
  const colorModeMutation = useMutation({
    mutationFn: (mode: "light" | "dark") => setColorMode({ mode }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.themes, data);
      showToast(data.mode === "dark" ? "Switched to dark mode" : "Switched to light mode");
      closePalette();
    },
    onError: (error) => showToast(error.message, "error")
  });
  const createTaskMutation = useMutation({
    mutationFn: (input: { readonly title: string; readonly listId?: string }) => createTask(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists })
      ]);
      showToast("Task created");
      closePalette();
    },
    onError: (error) => showToast(error.message, "error")
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCommandPaletteShortcut(event)) {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (open) closePalette();
        else openPalette();
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        closePalette();
      }
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [closePalette, open, openPalette]);

  useEffect(() => {
    window.addEventListener("jarvis:open-command-palette", openPalette);
    return () => window.removeEventListener("jarvis:open-command-palette", openPalette);
  }, [openPalette]);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, stage.kind]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, stage.kind]);

  useEffect(() => {
    if (activeIndex >= items.length) {
      setActiveIndex(items.length ? items.length - 1 : 0);
    }
  }, [activeIndex, items.length]);

  const runCommand = useCallback(
    (command: CommandPaletteCommand) => {
      if (command.action.kind === "navigate") {
        closePalette();
        props.navigate(command.action.to);
        return;
      }
      if (command.action.kind === "theme") {
        themeMutation.mutate(command.action.themeId);
        return;
      }
      if (command.action.kind === "set-color-mode") {
        colorModeMutation.mutate(command.action.mode);
        return;
      }
      setStage({ kind: "pick-list" });
      setQuery("");
    },
    [closePalette, colorModeMutation, props, themeMutation]
  );

  const submitTask = useCallback(
    (list: TaskListChoice) => {
      const title = taskTitle.trim();
      if (!title || createTaskMutation.isPending) return;
      createTaskMutation.mutate({
        title,
        listId: list.id ?? undefined
      });
    },
    [createTaskMutation, taskTitle]
  );

  const runActiveItem = useCallback(() => {
    const active = items[activeIndex];
    if (!active) return;
    if (isCommandItem(active)) {
      runCommand(active);
      return;
    }
    if (stage.kind === "pick-list") {
      setStage({ kind: "enter-title", list: active.list });
      setQuery("");
      return;
    }
    if (stage.kind === "enter-title") {
      submitTask(stage.list);
    }
  }, [activeIndex, items, runCommand, stage, submitTask]);

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      trapFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (items.length ? (current + 1) % items.length : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (items.length ? (current - 1 + items.length) % items.length : 0));
      return;
    }
    if (
      event.key === "Enter" &&
      shouldRunDialogEnter(stage.kind, event.target === inputRef.current)
    ) {
      event.preventDefault();
      runActiveItem();
    }
  }

  if (!open) return <PaletteToasts toasts={toasts} />;

  return (
    <>
      <PaletteToasts toasts={toasts} />
      <div
        className="kbar-scrim"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePalette();
        }}
      >
        <div
          ref={dialogRef}
          className="kbar"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onKeyDown={onDialogKeyDown}
        >
          <div className="kbar__input">
            <span className="ic">
              <Search size={18} aria-hidden="true" />
            </span>
            <input
              ref={inputRef}
              aria-label={inputLabel(stage)}
              placeholder={inputPlaceholder(stage)}
              type="text"
              value={stage.kind === "enter-title" ? taskTitle : query}
              onChange={(event) => {
                if (stage.kind === "enter-title") setTaskTitle(event.target.value);
                else setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (stage.kind === "enter-title" && event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  submitTask(stage.list);
                }
              }}
            />
            <span className="kbar__esc">Esc</span>
          </div>

          <div className="kbar__list" role="listbox" aria-label={listboxLabel(stage)}>
            {groups.length === 0 ? (
              <div className="kbar__empty">No matching commands.</div>
            ) : (
              groups.map((group) => (
                <div key={group.label}>
                  <div className="kbar__group">{group.label}</div>
                  {group.items.map((item) => {
                    const index = items.indexOf(item);
                    const active = index === activeIndex;
                    const Icon = itemIcon(item);
                    return (
                      <div
                        key={item.id}
                        role="option"
                        aria-selected={active}
                        className={`kbar__item ${active ? "is-active" : ""}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => {
                          if (isCommandItem(item)) runCommand(item);
                          else if (stage.kind === "pick-list") {
                            setStage({ kind: "enter-title", list: item.list });
                            setQuery("");
                          } else if (stage.kind === "enter-title") {
                            submitTask(stage.list);
                          }
                        }}
                      >
                        <span className="ic">
                          <Icon size={16} aria-hidden="true" />
                        </span>
                        <span className="lbl">
                          <span className="t">{item.label}</span>
                          <span className="d">{item.description}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="kbar__foot">
            <span className="k">
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              Move
            </span>
            <span className="k">
              <kbd>Enter</kbd>
              Run
            </span>
            <span className="k">
              <kbd>Esc</kbd>
              Close
            </span>
            <a href="https://motioneso.github.io/Jarv1s/" target="_blank" rel="noopener noreferrer">
              Weekly releases ↗
            </a>
          </div>
        </div>
      </div>
    </>
  );
}

function PaletteToasts(props: { readonly toasts: readonly PaletteToast[] }) {
  if (props.toasts.length === 0) return null;
  return (
    <div className="set-toasts">
      <div aria-live="polite" role="status" style={{ display: "contents" }}>
        {props.toasts
          .filter((toast) => toast.tone === "ready")
          .map((toast) => (
            <div key={toast.id} className="jds-toast jds-toast--ready">
              <span className="jds-toast__icon">
                <Check size={17} aria-hidden="true" />
              </span>
              <div className="jds-toast__body">
                <div className="jds-toast__msg">{toast.message}</div>
              </div>
            </div>
          ))}
      </div>
      <div aria-live="assertive" role="alert" style={{ display: "contents" }}>
        {props.toasts
          .filter((toast) => toast.tone === "error")
          .map((toast) => (
            <div key={toast.id} className="jds-toast jds-toast--error">
              <span className="jds-toast__icon">
                <AlertCircle size={17} aria-hidden="true" />
              </span>
              <div className="jds-toast__body">
                <div className="jds-toast__msg">{toast.message}</div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

export function taskChoices(lists: readonly TaskListDto[]): readonly TaskListChoice[] {
  if (lists.length > 0) return lists.map((list) => ({ id: list.id, name: list.name }));
  return [{ id: null, name: "Personal" }];
}

function listGroups(lists: readonly TaskListChoice[], query: string): readonly ListGroup[] {
  const needle = query.trim().toLowerCase();
  const items = lists
    .filter((list) => !needle || list.name.toLowerCase().includes(needle))
    .map((list) => ({
      id: `list:${list.id ?? "personal"}`,
      label: list.name,
      description: list.id ? "Create the task in this list" : "Use your default Personal list",
      icon: "check-square",
      list
    }));
  return items.length ? [{ label: "Task lists", items }] : [];
}

function titleGroups(list: TaskListChoice, title: string): readonly ListGroup[] {
  return [
    {
      label: "Create task",
      items: [
        {
          id: `submit:${list.id ?? "personal"}`,
          label: title.trim() || "Type a task title",
          description: `Press Enter to create in ${list.name}`,
          icon: "plus",
          list
        }
      ]
    }
  ];
}

function itemIcon(item: PaletteItem) {
  return ("icon" in item && item.icon ? NAV_ICON_MAP[item.icon] : null) ?? Layers3;
}

function isCommandItem(item: PaletteItem): item is CommandPaletteCommand {
  return "action" in item;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

export function isCommandPaletteShortcut(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly key: string;
  readonly code?: string;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "k" || event.code === "KeyK")
  );
}

function inputLabel(stage: Stage): string {
  if (stage.kind === "pick-list") return "Choose task list";
  if (stage.kind === "enter-title") return `Task title for ${stage.list.name}`;
  return "Search commands";
}

function inputPlaceholder(stage: Stage): string {
  if (stage.kind === "pick-list") return "Choose a task list…";
  if (stage.kind === "enter-title") return `Task title for ${stage.list.name}…`;
  return "Type a command or search…";
}

function listboxLabel(stage: Stage): string {
  if (stage.kind === "pick-list") return "Task lists";
  if (stage.kind === "enter-title") return "Create task";
  return "Commands";
}

function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>, root: HTMLDivElement | null) {
  if (!root) return;
  const nodes = focusableElements(root);
  if (nodes.length === 0) {
    event.preventDefault();
    return;
  }
  const currentIndex = nodes.findIndex((node) => node === document.activeElement);
  const nextIndex = nextFocusTrapIndex(currentIndex, nodes.length, event.shiftKey);
  if (nextIndex === null) return;
  event.preventDefault();
  nodes[nextIndex]?.focus();
}

export function nextFocusTrapIndex(
  currentIndex: number,
  total: number,
  shiftKey: boolean
): number | null {
  if (total <= 0) return 0;
  if (!shiftKey && currentIndex === total - 1) {
    return 0;
  }
  if (shiftKey && currentIndex <= 0) {
    return total - 1;
  }
  return null;
}

export function shouldRunDialogEnter(stageKind: Stage["kind"], targetIsInput: boolean): boolean {
  return !(stageKind === "enter-title" && targetIsInput);
}

export function restorePaletteFocus(element: HTMLElement | null): void {
  try {
    if (element?.isConnected) {
      element.focus();
    }
  } catch {
    // Stale focus targets are safe to ignore.
  }
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ].filter((node) => !node.hasAttribute("disabled") && node.tabIndex !== -1);
}

interface ListItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: string | null;
  readonly list: TaskListChoice;
}

interface ListGroup {
  readonly label: string;
  readonly items: readonly ListItem[];
}
