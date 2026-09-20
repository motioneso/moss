import type { ModuleWebContribution } from "@moss/module-web-sdk";

import { SportsPage } from "./sports-page.js";
import { SportsTodayWidget } from "./today-widget.js";

/**
 * Sports module web contribution (#799 module-web-registry Phase A) — the first module migrated
 * onto the `virtual:moss-module-web` plugin seam. `moduleId`/`path`/`icon`/`order` below are
 * literals mirroring `packages/sports/src/manifest.ts`'s `id`/`navigation[].path/icon/order`
 * (asserted by `tests/unit/module-web-scanner.test.ts`) rather than an import from `../manifest.js`
 * — that file pulls in `node:url` and backend-only tooling (briefing/dataset source code), which
 * must never be reachable from a browser-bundled `./web` entry (see
 * `tests/unit/module-web-browser-safety.test.ts`).
 */
const sportsWebContribution: ModuleWebContribution = {
  moduleId: "sports",
  routes: [
    {
      path: "/sports",
      title: "Sports",
      icon: "trophy",
      order: 35,
      element: <SportsPage />
    }
  ],
  todayWidgets: [{ slot: "sports", element: <SportsTodayWidget /> }]
};

export default sportsWebContribution;
