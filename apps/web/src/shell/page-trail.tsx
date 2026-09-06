import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { setPageTrailHook } from "@moss/module-web-sdk";

import { resolvePageHeading, webRoutes } from "../app-route-metadata.js";

export interface PageTrail {
  readonly name: string;
  readonly meta: string | null;
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
 * While the calling page is mounted the top bar shows section / name / meta; on unmount it
 * clears back to the plain title. Safe without a provider (module unit tests render pages
 * alone) — then it simply does nothing.
 */
export function usePageTrail(input: { readonly name: string; readonly meta?: string | null }) {
  const actions = useContext(PageTrailActionsContext);
  const name = input.name;
  const meta = input.meta ?? null;
  useEffect(() => {
    // No provider (a page rendered alone in a test) or no name yet (the project is still
    // loading) both mean the same thing: nothing to show, leave the plain title alone.
    if (!actions || !name) return;
    actions.setTrail({ name, meta });
    currentTrailName = name;
    return () => {
      currentTrailName = null;
      actions.clearTrail();
    };
  }, [actions, name, meta]);
}

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
    meta: trail.meta
  };
}

// The module isolation seam: workshop reaches this hook through `@moss/module-web-sdk`'s
// runtime-captured slot, never by importing the web app. Set once at module load, before any
// page renders, so the SDK's delegating call keeps a stable hook order.
setPageTrailHook(usePageTrail);
