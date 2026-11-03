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
      id: "proactive-monitoring.where-to-find",
      description:
        "Proactive monitoring has no screen or settings pane. Its cards appear on Today in a section titled Things worth your attention (kicker On your radar), each with a title, source (Tasks, Calendar, Email or Notes), summary and Dismiss."
    },
    {
      id: "proactive-monitoring.card-behaviour",
      description:
        "The section is absent when no card is active. Cards held back by quiet hours appear after they end. Moss can read the cards in chat, but cannot start a scan from chat."
    },
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
