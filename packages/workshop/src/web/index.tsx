import type { ModuleWebContribution } from "@moss/module-web-sdk";

import { WorkshopProjectRoutes } from "./project-routes.js";

// `moduleId`/`path`/`icon`/`order` below are literals mirroring
// `packages/workshop/src/manifest.ts`'s `id`/`navigation[].path/icon/order` (asserted by
// `tests/unit/module-web-scanner.test.ts`) rather than an import from `../manifest.js`, matching
// the defensive pattern `packages/sports/src/web/index.tsx` uses to keep browser-bundled `./web`
// entries away from backend-only tooling (see `tests/unit/module-web-browser-safety.test.ts`).
const workshopWebContribution: ModuleWebContribution = {
  moduleId: "workshop",
  routes: [
    {
      path: "/workshop",
      title: "The Workshop",
      icon: "wrench",
      order: 900,
      element: <WorkshopProjectRoutes />
    }
  ]
};

export default workshopWebContribution;
