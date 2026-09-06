import type { MossModuleManifest } from "@moss/module-sdk";
import {
  workshopBuildModuleInputSchema,
  workshopBuildModuleResultSchema,
  createWorkshopProjectInputSchema,
  createWorkshopProjectResponseSchema,
  listWorkshopProjectsResponseSchema,
  getWorkshopProjectResponseSchema,
  createWorkshopMessageInputSchema,
  createWorkshopMessageResponseSchema,
  listWorkshopMessagesResponseSchema
} from "@moss/shared";

import { workshopBuildModuleExecute } from "./assistant-tools.js";
import { collectWorkshopProjectFeed } from "./project-feed.js";
import { collectWorkshopProjects } from "./projects-repository.js";

export { WORKSHOP_MODULE_ID } from "@moss/shared";

export const workshopModuleManifest = {
  // The web scanner reads this literal without executing backend imports.
  id: "workshop",
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
  database: {
    migrations: ["0223_workshop_projects.sql", "0224_workshop_project_feed.sql"],
    ownedTables: ["app.workshop_projects", "app.workshop_project_feed"]
  },
  dataLifecycle: {
    exportSections: [
      {
        key: "workshopProjects",
        displayName: "Workshop projects",
        collect: collectWorkshopProjects
      },
      {
        key: "workshopProjectFeed",
        displayName: "Workshop project messages",
        collect: collectWorkshopProjectFeed
      }
    ],
    deletion: {
      strategy: "cascade",
      tables: [{ table: "app.workshop_project_feed" }, { table: "app.workshop_projects" }]
    }
  },
  navigation: [
    {
      id: "workshop",
      label: "The Workshop",
      description:
        "Create private projects, save requirements and messages, and revisit your work.",
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
      description: "Manage your private Workshop projects and see your earlier module builds.",
      scope: "admin",
      actions: ["view"]
    }
  ],
  features: [
    {
      id: "workshop.projects",
      description:
        "Admins can save private projects and messages. Other admins cannot access them. " +
        "Creation starts no planning or build; saved messages await delivery while the Workshop assistant is unavailable.",
      remediations: [
        {
          id: "workshop.projects.retry",
          description:
            "Reconnect and reload the project, then retry the saved request. Unsent text stays in the form.",
          path: "/workshop"
        }
      ],
      errors: [
        {
          code: "workshop.projects.load_failed",
          class: "transient",
          description: "The saved projects or messages could not be loaded."
        },
        {
          code: "workshop.projects.save_failed",
          class: "transient",
          description:
            "Saving could not be confirmed. Retrying the same request does not duplicate it."
        }
      ]
    },
    {
      id: "workshop.chat_handoff",
      description:
        "Moss saves only the requested idea as a private project and links to it. " +
        "Creation never plans or builds, including with YOLO. Incognito and unverified chats must use the create form.",
      remediations: [
        {
          id: "workshop.chat_handoff.choose_content",
          description: "Open the new-project form and choose the details you want to save.",
          path: "/workshop/new"
        }
      ],
      errors: [
        {
          code: "workshop.chat_handoff.private_source",
          class: "prerequisite",
          remediationRef: "workshop.chat_handoff.choose_content",
          description: "This chat cannot authorize saving a project. No chat content was copied."
        }
      ]
    }
  ],
  assistantActionFamilies: [
    {
      id: "module_builds",
      label: "Creating Workshop projects",
      description: "Save a private Workshop project from a request you gave Moss.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "workshop.buildModule",
      description:
        "Save a private Workshop project from the user's explicit request and return its link. " +
        "This only saves the request; it does not plan, build, install, or enqueue work. " +
        "Use a fresh requestKey UUID for each new project and reuse it for retries. " +
        "Do not copy conversation excerpts. Incognito or unverified chat sources must use /workshop/new.",
      permissionId: "workshop.view",
      actionFamilyId: "module_builds",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      requiresServices: ["moduleBuildStart"],
      inputSchema: workshopBuildModuleInputSchema,
      outputSchema: workshopBuildModuleResultSchema,
      // The saved project result supplies the browser with a real destination.
      streamsStructuredResult: true,
      execute: workshopBuildModuleExecute,
      summarize: () => "Save a private Workshop project. Planning has not started."
    }
  ],
  routes: [
    {
      method: "POST",
      path: "/api/workshop/projects",
      permissionId: "workshop.view",
      requestSchema: createWorkshopProjectInputSchema,
      responseSchema: createWorkshopProjectResponseSchema
    },
    {
      method: "GET",
      path: "/api/workshop/projects",
      permissionId: "workshop.view",
      responseSchema: listWorkshopProjectsResponseSchema
    },
    {
      method: "GET",
      path: "/api/workshop/projects/:projectId",
      permissionId: "workshop.view",
      responseSchema: getWorkshopProjectResponseSchema
    },
    {
      method: "GET",
      path: "/api/workshop/projects/:projectId/messages",
      permissionId: "workshop.view",
      responseSchema: listWorkshopMessagesResponseSchema
    },
    {
      method: "POST",
      path: "/api/workshop/projects/:projectId/messages",
      permissionId: "workshop.view",
      requestSchema: createWorkshopMessageInputSchema,
      responseSchema: createWorkshopMessageResponseSchema
    }
  ]
} satisfies MossModuleManifest;
