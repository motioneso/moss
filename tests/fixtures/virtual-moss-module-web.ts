import type { ModuleWebContribution } from "@moss/module-web-sdk";

/**
 * Test-only stand-in for the Vite-generated `virtual:moss-module-web` module
 * (#799 module-web-registry Phase A). Aliased in `vitest.config.ts` so the many files that
 * transitively import `apps/web/src/app-route-metadata.ts` (page-context, command-palette,
 * section-tour, today-page, etc.) resolve the virtual module the same way the real Vite build
 * does, without every consuming test needing its own `vi.mock("virtual:moss-module-web", ...)`.
 *
 * Mirrors exactly what `packages/settings-ui/src/scanner.ts`'s `scanModuleWeb` would emit for the
 * modules with a `./web` export (sports, news, workshop) — keep this in sync if a future phase
 * docks another module's `./web` contribution.
 */
export const MODULE_WEB_ROUTES = [
  {
    moduleId: "news",
    moduleName: "News",
    id: "news",
    label: "News",
    path: "/news",
    icon: "newspaper",
    order: 34,
    permissionId: "news.view"
  },
  {
    moduleId: "sports",
    moduleName: "Sports",
    id: "sports",
    label: "Sports",
    path: "/sports",
    icon: "trophy",
    order: 35,
    permissionId: "sports.view"
  },
  {
    moduleId: "workshop",
    moduleName: "Workshop",
    id: "workshop",
    label: "The Workshop",
    path: "/workshop",
    icon: "wrench",
    order: 900,
    permissionId: "workshop.view"
  }
];

export const MODULE_WEB_CONTRIBUTIONS: ReadonlyArray<{
  readonly moduleId: string;
  readonly load: () => Promise<{ readonly default: ModuleWebContribution }>;
}> = [
  { moduleId: "news", load: () => import("@moss/news/web") },
  { moduleId: "sports", load: () => import("@moss/sports/web") },
  { moduleId: "workshop", load: () => import("@moss/workshop/web") }
];
