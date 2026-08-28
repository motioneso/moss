import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";
import { WORKFLOW_STEP_DEADLETTER_QUEUE, WORKFLOW_STEP_EXECUTE_QUEUE } from "./jobs.js";

export const WORKFLOWS_MODULE_ID = "workflows";

export const workflowsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const workflowsModuleManifest = {
  id: WORKFLOWS_MODULE_ID,
  name: "Workflows",
  publisher: "Moss",
  version: "1.0.0",
  // Platform plumbing, not a feature a user turns off: workflow run state has to exist for
  // any module that declares a workflow. The compatibility gate also rejects a built-in that
  // is not enabled by default.
  lifecycle: "required",
  availability: { defaultEnabled: true, required: true },
  compatibility: { jarv1s: ">=0.0.0" },
  database: {
    migrations: ["0202_workflow_runs.sql"],
    ownedTables: [
      "app.workflow_runs",
      "app.workflow_step_runs",
      "app.workflow_approvals",
      "app.workflow_artifacts"
    ]
  },
  jobs: [
    { queueName: WORKFLOW_STEP_EXECUTE_QUEUE, metadataOnly: true },
    { queueName: WORKFLOW_STEP_DEADLETTER_QUEUE, metadataOnly: true }
  ],
  permissions: [
    {
      id: "workflows.view",
      label: "View workflow runs",
      description: "Read the active actor's own workflow runs, steps and approvals.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "workflows.manage",
      label: "Manage workflow runs",
      description: "Cancel the active actor's own workflow runs and answer their approvals.",
      scope: "user",
      actions: ["update"]
    }
  ],
  // Every route the server registers must appear here or startup fails outright
  // (packages/module-registry/src/route-guard.ts) — and no test would ever see the endpoint,
  // because the failure happens before any route is reachable.
  routes: [
    { method: "GET", path: "/api/workflows/runs", permissionId: "workflows.view" },
    { method: "GET", path: "/api/workflows/runs/:id", permissionId: "workflows.view" },
    { method: "POST", path: "/api/workflows/runs/:id/cancel", permissionId: "workflows.manage" },
    {
      method: "POST",
      path: "/api/workflows/approvals/:id/resolve",
      permissionId: "workflows.manage"
    }
  ],
  dataLifecycle: {
    // Empty on purpose. Workflow run state is machine bookkeeping — which step ran, what it
    // returned, whether an approval was answered — not user content. Anything a user would
    // recognise as theirs lives in the module that started the run and is exported there.
    exportSections: [],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.workflow_runs" },
        { table: "app.workflow_step_runs" },
        { table: "app.workflow_approvals" },
        { table: "app.workflow_artifacts" }
      ]
    }
  }
} satisfies MossModuleManifest;
