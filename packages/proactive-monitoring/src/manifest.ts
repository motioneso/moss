import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";

export const proactiveMonitoringSqlMigrationDirectory = fileURLToPath(
  new URL("./sql", import.meta.url)
);

export const proactiveMonitoringModuleManifest = {
  id: "proactive-monitoring",
  name: "Proactive Monitoring",
  version: "0.0.0",
  publisher: "Moss",
  lifecycle: "required",
  compatibility: { jarv1s: ">=0.0.0" },
  availability: {
    defaultEnabled: true,
    required: true
  },
  database: {
    migrations: [],
    migrationDirectories: [proactiveMonitoringSqlMigrationDirectory],
    ownedTables: ["app.proactive_monitor_state", "app.proactive_cards"]
  },
  features: [
    {
      id: "proactive-monitoring.quiet_hours",
      description:
        "Proactive cards found during quiet hours defer until the local daily end. They follow " +
        "the saved quiet-hours schedule in its own time zone; while an older alert schedule " +
        "differs from it, they keep following the older one."
    }
  ],
  permissions: [
    {
      id: "proactive-monitoring.view",
      label: "View proactive cards",
      description: "Read proactive monitoring cards.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "proactive-monitoring.refresh",
      label: "Refresh proactive scan",
      description: "Trigger a proactive monitoring scan.",
      scope: "user",
      actions: ["create"]
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/me/proactive-cards",
      chat: { access: "read" },
      permissionId: "proactive-monitoring.view"
    },
    {
      method: "POST",
      path: "/api/me/proactive-cards/refresh",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "proactive-monitoring.refresh"
    }
  ]
} satisfies MossModuleManifest;
