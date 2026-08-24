import type { MossModuleManifest } from "@moss/module-sdk";

export const WORKSHOP_MODULE_ID = "workshop";

export const workshopModuleManifest = {
  id: WORKSHOP_MODULE_ID,
  name: "Workshop",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "required",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: true
  },
  navigation: [
    {
      id: "workshop",
      label: "The Workshop",
      description: "See modules Moss is building, and the ones already running.",
      path: "/workshop",
      icon: "wrench",
      order: 900,
      permissionId: "workshop.view"
    }
  ],
  permissions: [
    {
      id: "workshop.view",
      label: "View the workshop",
      description: "See instance-wide module builds and installed modules.",
      scope: "admin",
      actions: ["view"]
    }
  ],
  routes: []
} satisfies MossModuleManifest;
