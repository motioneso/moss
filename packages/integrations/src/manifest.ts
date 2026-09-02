import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";

export const INTEGRATIONS_MODULE_ID = "integrations";

export const integrationsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const integrationsModuleManifest = {
  id: INTEGRATIONS_MODULE_ID,
  name: "Integrations",
  publisher: "Moss",
  version: "1.0.0",
  lifecycle: "required",
  availability: { defaultEnabled: true, required: true },
  compatibility: { jarv1s: ">=0.0.0" },
  // Chat tools are dynamic (one per discovered connection tool), so there is no static
  // assistantTools list — see Task 8.
  routes: [
    { method: "GET", path: "/api/integrations" },
    { method: "POST", path: "/api/integrations" },
    { method: "GET", path: "/api/integrations/:id" },
    { method: "PATCH", path: "/api/integrations/:id" },
    { method: "POST", path: "/api/integrations/:id/refresh" },
    { method: "DELETE", path: "/api/integrations/:id" }
  ],
  dataLifecycle: {
    exportSections: [],
    deletion: {
      strategy: "cascade",
      tables: [{ table: "app.integration_connections" }]
    }
  },
  features: [
    {
      id: "integrations.connection_detail_grouped_tools",
      description:
        "A connection's tool list is grouped, with each tool getting a per-tool switch to allow " +
        "repeated identical calls (off by default). Notes explain grandfathered connections and " +
        "point to Refresh tools when read/repeat hints are missing."
    }
  ]
} satisfies MossModuleManifest;
