import type { MossModuleManifest } from "@moss/module-sdk";
import {
  workshopBuildModuleInputSchema,
  workshopBuildModuleResultSchema,
  workshopRunCommandInputSchema,
  workshopRunCommandResultSchema,
  createWorkshopProjectInputSchema,
  createWorkshopProjectResponseSchema,
  deleteWorkshopProjectResponseSchema,
  listWorkshopProjectsResponseSchema,
  getWorkshopProjectResponseSchema,
  createWorkshopMessageInputSchema,
  createWorkshopMessageResponseSchema,
  listWorkshopMessagesResponseSchema,
  renameWorkshopProjectInputSchema,
  renameWorkshopProjectResponseSchema
} from "@moss/shared";

import { workshopBuildModuleExecute } from "./assistant-tools.js";
import { WORKSHOP_RUN_COMMAND_SERVICE_KEY, workshopRunCommandExecute } from "./run-command.js";
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
    migrations: [
      "0223_workshop_projects.sql",
      "0224_workshop_project_feed.sql",
      "0228_workshop_project_rename_delete.sql"
    ],
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
        "Create projects, save requirements and messages, and revisit your work. Inside a " +
        "project the top bar shows The Workshop as the way back, followed by the project name.",
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
      description: "Manage your Workshop projects.",
      scope: "admin",
      actions: ["view"]
    }
  ],
  features: [
    {
      id: "workshop.projects",
      description:
        "Admins can save private projects and messages; other admins cannot access them. " +
        "Creating a project starts no planning or build. The Workshop assistant replies to each " +
        "message, marked awaiting delivery only if that reply fails.",
      remediations: [
        {
          id: "workshop.projects.retry",
          description:
            "Reconnect and reload the project, then retry the saved request. Unsent text stays in the window.",
          path: "/workshop"
        },
        {
          id: "workshop.projects.rename_retry",
          description: "Open the More menu and choose Rename, then enter the name again.",
          path: "/workshop"
        },
        {
          id: "workshop.projects.delete_retry",
          description: "Open the More menu and choose Delete project again.",
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
        },
        {
          code: "workshop.projects.rename_failed",
          class: "transient",
          description:
            "The new name could not be saved. The old name is back. Try entering it again."
        },
        {
          code: "workshop.projects.delete_failed",
          class: "transient",
          description: "The project could not be deleted. It is still there. Try deleting it again."
        }
      ]
    },
    {
      id: "workshop.chat_handoff",
      description:
        "Moss saves only the requested idea as a private project and links to it. " +
        "Creation never plans or builds, including with YOLO. Incognito and unverified chats must use the new-project window.",
      remediations: [
        {
          id: "workshop.chat_handoff.choose_content",
          description: "Start a new project and say what you want in your own words.",
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
    },
    {
      id: "workshop_builds",
      label: "Running project build commands",
      description:
        "Run one shell command with the project folder as its working folder and report the " +
        "output. The command itself is not restricted to that folder.",
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
    },
    {
      name: "workshop.runCommand",
      description:
        "Run one shell command with the project folder as its working folder and return its " +
        "output. The folder is fixed to this session's project; there is no path to choose. " +
        "The command itself is not restricted to that folder. Use for build, test, and check " +
        "commands. Output past 256 KiB is cut with a note, and past the deadline the command " +
        "stops and whatever ran so far returns.",
      permissionId: "workshop.view",
      actionFamilyId: "workshop_builds",
      risk: "write",
      executionPolicy: "auto",
      // user_promotable, never granted_at_install: this runs arbitrary shell, so
      // installing the module must not silently grant unattended runs. The user
      // promotes the family to trusted_auto for unattended builds.
      selfOperationGrant: "user_promotable",
      requiresServices: [WORKSHOP_RUN_COMMAND_SERVICE_KEY],
      inputSchema: workshopRunCommandInputSchema,
      outputSchema: workshopRunCommandResultSchema,
      execute: workshopRunCommandExecute,
      // The card is the only human control here, so it shows the whole command:
      // over-long commands are refused up front, never silently cut.
      summarize: (input) => {
        const command = typeof input.command === "string" ? input.command : "";
        return `Run this project command: ${command}`;
      }
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
      method: "PATCH",
      path: "/api/workshop/projects/:projectId",
      permissionId: "workshop.view",
      requestSchema: renameWorkshopProjectInputSchema,
      responseSchema: renameWorkshopProjectResponseSchema
    },
    {
      method: "DELETE",
      path: "/api/workshop/projects/:projectId",
      permissionId: "workshop.view",
      responseSchema: deleteWorkshopProjectResponseSchema
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
