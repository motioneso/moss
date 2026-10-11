import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";

import { commitmentsListVisibleExecute } from "./tools.js";

export const STRUCTURED_STATE_MODULE_ID = "structured-state";
export const structuredStateSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const structuredStateModuleManifest: MossModuleManifest = {
  id: STRUCTURED_STATE_MODULE_ID,
  name: "Structured State",
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
  database: {
    migrations: [
      "sql/0031_structured_state.sql",
      "sql/0070_commitments_worker_grant.sql",
      "sql/0093_preferences_worker_runtime_grants.sql",
      "sql/0111_preferences_worker_write.sql",
      "sql/0167_worker_entities_grant.sql",
      "sql/0175_preferences_revision.sql"
    ],
    migrationDirectories: ["packages/structured-state/sql"],
    ownedTables: ["app.commitments", "app.entities", "app.preferences"]
  },
  permissions: [
    {
      id: "commitments.view",
      label: "View commitments",
      description: "Read commitments visible to the active actor.",
      scope: "user",
      actions: ["view"]
    }
  ],
  assistantTools: [
    {
      name: "commitments.listVisible",
      description: "List commitments owned by or shared with the active actor.",
      permissionId: "commitments.view",
      risk: "read",
      content: "outside",
      inputSchema: { type: "object", properties: {} },
      execute: commitmentsListVisibleExecute
    }
  ],
  shareableResources: [
    { resourceType: "commitment", grantLevels: ["view"] },
    { resourceType: "entity", grantLevels: ["view"] }
  ]
};
