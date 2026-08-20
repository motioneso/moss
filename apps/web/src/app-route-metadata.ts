import {
  CORE_APP_SCREENS,
  type LocaleSettingsDto,
  type ModuleDto,
  type ModuleNavigationEntryDto
} from "@moss/shared";
import { MODULE_WEB_ROUTES } from "virtual:moss-module-web";

import { DEFAULT_LOCALE, formatDate } from "./locale/locale-format.js";

const TOP_SECTION = "__top";
const SECTION_ORDER: readonly string[] = [TOP_SECTION, "Plan", "You"];
const SECTION_OF: Record<string, string> = {
  tasks: "Plan",
  calendar: "Plan",
  wellness: "You",
  sports: "You",
  news: "You"
};
const HIDDEN_NAV_IDS = new Set(["chat", "briefings", "settings", "notifications"]);

export interface WebRouteMeta {
  // Widened from a literal union (#799): module-contributed routes are discovered at build time
  // from `virtual:moss-module-web`, so their ids are not statically enumerable here.
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly subtitle: (now: Date, locale: LocaleSettingsDto) => string;
  readonly match: (pathname: string) => boolean;
}

export interface NavSection {
  readonly key: string;
  readonly label: string | null;
  readonly items: readonly ModuleNavigationEntryDto[];
}

const todayCoreScreen = CORE_APP_SCREENS.find(({ id }) => id === "today")!;

export const todayNavEntry: ModuleNavigationEntryDto = {
  id: todayCoreScreen.id,
  label: todayCoreScreen.label,
  path: todayCoreScreen.path,
  icon: "house",
  order: -1
};

export const webRoutes: readonly WebRouteMeta[] = [
  {
    id: "today",
    path: "/today",
    title: "Today",
    // Date + time live in the Today masthead (dateline + clock) — keep them out of the topbar.
    subtitle: () => "",
    match: (pathname) => pathname === "/" || pathname.startsWith("/today")
  },
  {
    id: "tasks",
    path: "/tasks",
    title: "Tasks",
    subtitle: dateEyebrow,
    match: (pathname) => pathname === "/tasks"
  },
  {
    id: "notifications",
    path: "/notifications",
    title: "Notifications",
    subtitle: () => "",
    match: (pathname) => pathname.startsWith("/notifications")
  },
  {
    id: "calendar",
    path: "/calendar",
    title: "Calendar",
    subtitle: monthEyebrow,
    match: (pathname) => pathname.startsWith("/calendar")
  },
  {
    id: "wellness",
    path: "/wellness",
    title: "Wellness",
    subtitle: dateEyebrow,
    match: (pathname) => pathname.startsWith("/wellness")
  },
  // Module-contributed routes (#799): discovered from each module's `./web` manifest navigation
  // at build time rather than hardcoded per module. Deviation from the prior sports entry: the
  // generated subtitle is always empty (the manifest doesn't carry a topbar eyebrow string like
  // the old sports-specific "FOLLOWED" label) — see PR description for the accepted trade-off.
  ...MODULE_WEB_ROUTES.map(
    (route): WebRouteMeta => ({
      id: route.moduleId,
      path: route.path,
      title: route.label,
      subtitle: () => "",
      match: (pathname) => pathname.startsWith(route.path)
    })
  ),
  {
    id: "settings",
    path: "/settings",
    title: "Settings & permissions",
    subtitle: () => "",
    match: (pathname) => pathname.startsWith("/settings")
  }
];

export function webRoutePath(id: WebRouteMeta["id"]): string {
  const route = webRoutes.find((item) => item.id === id);
  if (!route) throw new Error(`Unknown web route: ${id}`);
  return route.path;
}

// #1734: an internal grouping key, deliberately in the same `__`-prefixed shape as TOP_SECTION so
// it can never be mistaken for a label. It used to be the literal string "Modules" and was
// rendered as a section header, which told the user how the software is packaged — our word, not
// theirs. The grouping stays (see D5 below); only the visible header is gone.
const INSTALLED_SECTION = "__installed";

export function buildShellNavigation(
  modules: readonly ModuleDto[],
  disabledModuleIds: readonly string[]
): NavSection[] {
  const disabled = new Set(disabledModuleIds);
  const entries = modules
    .filter((module) => !disabled.has(module.id))
    .flatMap((module) =>
      module.navigation
        .filter((entry) => !HIDDEN_NAV_IDS.has(entry.id))
        .map((entry) => ({ entry, external: module.external === true }))
    )
    .sort((left, right) => {
      const leftOrder = left.entry.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.entry.order ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.entry.label.localeCompare(right.entry.label);
    });

  const bySection = new Map<string, ModuleNavigationEntryDto[]>();
  bySection.set(TOP_SECTION, [todayNavEntry]);
  for (const { entry, external } of entries) {
    // #1019 (D5): an external module's entries NEVER consult SECTION_OF — they always land
    // in the dedicated tail section, even if the manifest id happens to collide with a
    // built-in section key (the validator's #1019 id-prefix rule makes a real collision
    // impossible, but the shell doesn't rely on that alone).
    const section = external ? INSTALLED_SECTION : (SECTION_OF[entry.id] ?? TOP_SECTION);
    const bucket = bySection.get(section) ?? [];
    bucket.push(entry);
    bySection.set(section, bucket);
  }

  const orderedKeys = [
    ...SECTION_ORDER.filter((key) => bySection.has(key)),
    ...[...bySection.keys()].filter((key) => !SECTION_ORDER.includes(key))
  ];

  return orderedKeys.map((key) => ({
    key,
    // Both internal keys render headerless: the top group never had a header, and the installed
    // group's header was the word "Modules" (#1734). An installed thing is just another entry in
    // the list, the same way Tasks is.
    label: key === TOP_SECTION || key === INSTALLED_SECTION ? null : key,
    items: bySection.get(key) ?? []
  }));
}

export function resolvePageHeading(
  pathname: string,
  now = new Date(),
  locale: LocaleSettingsDto = DEFAULT_LOCALE,
  runtimeModules: readonly ModuleDto[] = []
): { title: string; subtitle: string } {
  const moduleId = pathname.match(/^\/m\/([^/]+)/)?.[1];
  const runtimeModule = runtimeModules.find(
    (module) => module.external === true && module.id === moduleId
  );
  const navigationEntry = runtimeModule?.navigation.find(
    (entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`)
  );
  if (navigationEntry) return { title: navigationEntry.label, subtitle: "" };

  const route = webRoutes.find((item) => item.match(pathname)) ?? webRoutes[0];
  if (!route) throw new Error("At least one web route must be defined");
  return { title: route.title, subtitle: route.subtitle(now, locale) };
}

function dateEyebrow(now: Date, locale: LocaleSettingsDto): string {
  const weekday = formatDate(now, locale, { weekday: "short" });
  const month = formatDate(now, locale, { month: "short" });
  const day = formatDate(now, locale, { day: "numeric" });
  return `${weekday} · ${month} ${day}`.toUpperCase();
}

function monthEyebrow(now: Date, locale: LocaleSettingsDto): string {
  return formatDate(now, locale, { month: "long", year: "numeric" }).toUpperCase();
}
