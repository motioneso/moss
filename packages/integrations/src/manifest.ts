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
  }
} satisfies MossModuleManifest;
