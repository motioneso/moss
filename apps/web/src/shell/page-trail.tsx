import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Ellipsis } from "lucide-react";
import { Menu, setPageTrailHook, type PageTrailAction } from "@moss/module-web-sdk";

import { resolvePageHeading, webRoutes } from "../app-route-metadata.js";

export interface PageTrail {
  readonly name: string;
  readonly meta: string | null;
  readonly actions: readonly PageTrailAction[];
  readonly onRename: ((name: string) => Promise<void>) | null;
  readonly onAction: ((id: string) => void) | null;
}

interface PageTrailActions {
  readonly setTrail: (trail: PageTrail) => void;
  readonly clearTrail: () => void;
}

// Split in two on purpose: the setter below reads actions only, so publishing a trail never
// re-renders the setter itself — a single context object (a new identity on every render)
// retriggered the setter's effect off its own write, an infinite set-state loop.
const PageTrailStateContext = createContext<PageTrail | null>(null);
const PageTrailActionsContext = createContext<PageTrailActions | null>(null);

/** Latest trail name outside React, so page context can name the project Moss is looking at. */
let currentTrailName: string | null = null;

export function getPageTrailName(): string | null {
  return currentTrailName;
}

export function PageTrailProvider({ children }: { readonly children: ReactNode }) {
  const [trail, setTrailState] = useState<PageTrail | null>(null);
  const actions = useMemo<PageTrailActions>(
    () => ({
      setTrail: (next: PageTrail) => setTrailState(next),
      clearTrail: () => setTrailState(null)
    }),
    []
  );
  return (
    <PageTrailStateContext.Provider value={trail}>
      <PageTrailActionsContext.Provider value={actions}>
        {children}
      </PageTrailActionsContext.Provider>
    </PageTrailStateContext.Provider>
  );
}

/**
 * While the calling page is mounted the top bar shows section / name / meta (plus the page's
 * "More" actions and rename, when given); on unmount it clears back to the plain title. Safe
 * without a provider (module unit tests render pages alone) — then it simply does nothing.
 */
export function usePageTrail(input: {
  readonly name: string;
  readonly meta?: string | null;
  readonly actions?: readonly PageTrailAction[];
  readonly onRename?: (name: string) => Promise<void>;
  readonly onAction?: (id: string) => void;
}) {
  const actions = useContext(PageTrailActionsContext);
  const name = input.name;
  const meta = input.meta ?? null;
  const trailActions = input.actions ?? EMPTY_TRAIL_ACTIONS;
  const onRename = input.onRename ?? null;
  const onAction = input.onAction ?? null;
  useEffect(() => {
    // No provider (a page rendered alone in a test) or no name yet (the project is still
    // loading) both mean the same thing: nothing to show, leave the plain title alone.
    if (!actions || !name) return;
    actions.setTrail({ name, meta, actions: trailActions, onRename, onAction });
    currentTrailName = name;
    return () => {
      currentTrailName = null;
      actions.clearTrail();
    };
  }, [actions, name, meta, trailActions, onRename, onAction]);
}

const EMPTY_TRAIL_ACTIONS: readonly PageTrailAction[] = [];

export function usePageTrailValue(): PageTrail | null {
  return useContext(PageTrailStateContext);
}

export interface PageTrailSection {
  readonly label: string;
  readonly path: string;
}

/** Section label and path for the trail, from the same route table as the plain title. */
export function resolveTrailSection(pathname: string): PageTrailSection {
  const route = webRoutes.find((item) => item.match(pathname));
  if (route) return { label: route.title, path: route.path };
  const { title } = resolvePageHeading(pathname);
  return { label: title, path: "/" };
}

export interface PageTrailDisplay {
  readonly sectionLabel: string;
  readonly sectionPath: string;
  readonly name: string;
  readonly meta: string | null;
  readonly actions: readonly PageTrailAction[];
  readonly onRename: ((name: string) => Promise<void>) | null;
  readonly onAction: ((id: string) => void) | null;
}

/** Everything the top bar needs to render the trail on this route, or null when unset. */
export function usePageTrailDisplay(): PageTrailDisplay | null {
  const trail = usePageTrailValue();
  const location = useLocation();
  if (!trail) return null;
  const section = resolveTrailSection(location.pathname);
  return {
    sectionLabel: section.label,
    sectionPath: section.path,
    name: trail.name,
    meta: trail.meta,
    actions: trail.actions,
    onRename: trail.onRename,
    onAction: trail.onAction
  };
}

/**
 * The trail as the top bar renders it: the section as the way back, then the page name (a
 * rename button when the page allows it) and its meta note. Owned by the shell so every module
 * renames the same way.
 */
export function TopbarTrail(props: {
  readonly sectionLabel: string;
  readonly sectionPath: string;
  readonly name: string;
  readonly meta: string | null;
  readonly onRename: ((name: string) => Promise<void>) | null;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="topbar-title-row topbar-crumb">
      <Link className="topbar-title topbar-title--link" to={props.sectionPath}>
        {props.sectionLabel}
      </Link>
      <span className="topbar-crumb__sep" aria-hidden="true">
        /
      </span>
      <EditableTrailName name={props.name} onRename={props.onRename} />
      {props.meta ? <span className="topbar-crumb__meta">{props.meta}</span> : null}
      {props.trailing}
    </div>
  );
}

function EditableTrailName(props: {
  readonly name: string;
  readonly onRename: ((name: string) => Promise<void>) | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // An edit never survives navigation or a new name: the moment the trail moves on, the editor
  // goes back to rest.
  useEffect(() => {
    setDraft(null);
    setPendingName(null);
    setFailed(false);
  }, [props.name]);

  if (!props.onRename) {
    return <span className="topbar-crumb__now">{props.name}</span>;
  }
  const onRename = props.onRename;
  if (pendingName !== null) {
    return <span className="topbar-crumb__now">{pendingName}</span>;
  }
  if (draft === null) {
    return (
      <>
        <button
          type="button"
          className="topbar-crumb__now topbar-crumb__now--editable"
          title="Click to rename"
          onClick={() => {
            setDraft(props.name);
            setFailed(false);
          }}
        >
          {props.name}
        </button>
        {failed ? (
          <span className="topbar-crumb__error" role="alert">
            Could not rename. Try again.
          </span>
        ) : null}
      </>
    );
  }
  const trimmed = draft.trim();
  const submit = () => {
    if (!trimmed) return;
    if (trimmed === props.name) {
      setDraft(null);
      return;
    }
    setPendingName(trimmed);
    setDraft(null);
    void onRename(trimmed).catch(() => {
      setPendingName(null);
      setFailed(true);
    });
  };
  return (
    <form
      className="topbar-rename"
      aria-label="Rename this project"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onBlur={(event) => {
        // Tabbing between the field and its own buttons is not leaving: the buttons act.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (trimmed && trimmed !== props.name) submit();
        else setDraft(null);
      }}
    >
      <input
        className="jds-input topbar-rename__input"
        type="text"
        aria-label="Project name"
        value={draft}
        maxLength={160}
        ref={(element) => {
          element?.focus();
          element?.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
        }}
      />
      <button type="submit" className="jds-btn jds-btn--primary jds-btn--sm" disabled={!trimmed}>
        Save
      </button>
      <button
        type="button"
        className="jds-btn jds-btn--quiet jds-btn--sm"
        onClick={() => setDraft(null)}
      >
        Cancel
      </button>
    </form>
  );
}

/**
 * The shell's "More" button for the bar's right: three dots opening exactly the page's action
 * items and nothing else. Rendered only when the page gives actions.
 */
export function TopbarMoreActions(props: {
  readonly actions: readonly PageTrailAction[];
  readonly onAction: ((id: string) => void) | null;
}) {
  if (props.actions.length === 0) return null;
  return (
    <Menu
      triggerIcon={<Ellipsis size={19} aria-hidden="true" />}
      triggerLabel="More"
      items={props.actions.map((action) => ({ id: action.id, label: action.label }))}
      onSelect={(id) => props.onAction?.(id)}
    />
  );
}

// The module isolation seam: workshop reaches this hook through `@moss/module-web-sdk`'s
// runtime-captured slot, never by importing the web app. Set once at module load, before any
// page renders, so the SDK's delegating call keeps a stable hook order.
setPageTrailHook(usePageTrail);
