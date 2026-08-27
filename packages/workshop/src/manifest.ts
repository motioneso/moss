import type { MossModuleManifest } from "@moss/module-sdk";
import { workshopBuildModuleInputSchema, workshopBuildModuleResultSchema } from "@moss/shared";

import { workshopBuildModuleExecute } from "./assistant-tools.js";

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
  assistantActionFamilies: [
    {
      id: "module_builds",
      label: "Building new modules",
      description: "Plan and build a new module you asked Moss for.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "workshop.buildModule",
      description:
        "Start building a new module for this instance, and show the user the plan for approval. " +
        "Only call this once you have gathered what the module should do, what it needs to reach, " +
        "and when it should run — ask those questions in conversation first. Calling this does NOT " +
        "install or ship anything: it writes a plan and waits for the user to press Build it.",
      permissionId: "workshop.view",
      actionFamilyId: "module_builds",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      requiresServices: ["moduleBuildStart"],
      inputSchema: workshopBuildModuleInputSchema,
      outputSchema: workshopBuildModuleResultSchema,
      // The plan card IS the approval gate (it lists what the module reaches and what it costs),
      // so the tool streams its structured result to the browser instead of only rendered text.
      streamsStructuredResult: true,
      execute: workshopBuildModuleExecute,
      summarize: () => "Plan a new module and show it for approval."
    }
  ],
  routes: []
} satisfies MossModuleManifest;
