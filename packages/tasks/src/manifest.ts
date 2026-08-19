import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import { tasksMonitorProvider } from "./monitor-provider.js";
import {
  addTaskActivityRequestSchema,
  addTaskActivityResponseSchema,
  assignTaskTagRequestSchema,
  assignTaskTagRouteSchema,
  atRiskTasksResponseSchema,
  breakdownTaskRequestSchema,
  breakdownTaskResponseSchema,
  createTaskListRequestSchema,
  createTaskListResponseSchema,
  createTaskRequestSchema,
  createTaskResponseSchema,
  createTaskTagRequestSchema,
  createTaskTagResponseSchema,
  deferredTaskStatusPayloadSchema,
  deferredTaskStatusRequestSchema,
  deferredTaskStatusResponseSchema,
  deleteTaskListRequestSchema,
  deleteTaskListRouteSchema,
  deleteTaskTagRouteSchema,
  focusTasksResponseSchema,
  getTaskResponseSchema,
  interpretTaskSearchRequestSchema,
  interpretTaskSearchResponseSchema,
  listTaskListsResponseSchema,
  listTaskTagsResponseSchema,
  listTasksResponseSchema,
  overdueTasksResponseSchema,
  renameTaskListRequestSchema,
  renameTaskListRouteSchema,
  renameTaskTagRequestSchema,
  renameTaskTagRouteSchema,
  taskDtoSchema,
  taskListDtoSchema,
  taskStatusSchema,
  taskTagDtoSchema,
  unassignTaskTagRouteSchema,
  updateTaskRequestSchema,
  updateTaskResponseSchema
} from "@moss/shared";

import {
  taskAddActivityExecute,
  taskAssignTagExecute,
  taskActivityExecute,
  taskAtRiskExecute,
  taskBreakDownExecute,
  taskCreateExecute,
  taskCreateListExecute,
  taskCreateTagExecute,
  taskDeleteListExecute,
  taskDeleteTagExecute,
  taskFocusExecute,
  taskGetExecute,
  taskListExecute,
  taskListListsExecute,
  taskListTagsExecute,
  taskOverdueExecute,
  taskRenameListExecute,
  taskRenameTagExecute,
  taskUnassignTagExecute,
  taskUpdateExecute,
  taskUpdateStatusExecute
} from "./tools.js";

export const TASKS_MODULE_ID = "tasks";
export const TASKS_DEFERRED_STATUS_QUEUE = "tasks-deferred-status";
export const TASKS_RECURRENCE_QUEUE = "tasks-recurrence-materialize";
export const tasksModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

const taskItemsToolOutputSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: taskDtoSchema }
  }
} as const;

const taskListItemsToolOutputSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: taskListDtoSchema }
  }
} as const;

const taskTagItemsToolOutputSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: taskTagDtoSchema }
  }
} as const;

const taskMutationToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    task: taskDtoSchema,
    error: { type: "string" }
  }
} as const;

const taskBreakdownToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tasks: { type: "array", items: taskDtoSchema },
    error: { type: "string" }
  }
} as const;

const taskActivityToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    activity: addTaskActivityResponseSchema.properties.activity,
    error: { type: "string" }
  }
} as const;

const taskListMutationToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    list: taskListDtoSchema,
    error: { type: "string" }
  }
} as const;

const taskTagMutationToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tag: taskTagDtoSchema,
    error: { type: "string" }
  }
} as const;

const taskUpdateToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: {
    taskId: { type: "string" },
    ...updateTaskRequestSchema.properties
  }
} as const;

const taskBreakdownToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "steps"],
  properties: {
    taskId: { type: "string" },
    steps: breakdownTaskRequestSchema.properties.steps
  }
} as const;

const taskActivityToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: {
    taskId: { type: "string" },
    ...addTaskActivityRequestSchema.properties
  }
} as const;

const taskTagAssignmentToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "tagId"],
  properties: {
    taskId: { type: "string" },
    tagId: { type: "string" }
  }
} as const;

const taskListRenameToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "name"],
  properties: {
    listId: { type: "string" },
    name: { type: "string" }
  }
} as const;

const taskTagCreateToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "name"],
  properties: {
    listId: { type: "string" },
    name: { type: "string" }
  }
} as const;

const taskTagRenameToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "tagId", "name"],
  properties: {
    listId: { type: "string" },
    tagId: { type: "string" },
    name: { type: "string" }
  }
} as const;

const taskDeleteListToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId"],
  properties: {
    listId: { type: "string" },
    reassignToListId: { type: "string" }
  }
} as const;

const taskDeleteTagToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "tagId"],
  properties: {
    listId: { type: "string" },
    tagId: { type: "string" }
  }
} as const;

const taskDeleteToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    deleted: { type: "boolean" },
    error: { type: "string" }
  }
} as const;

export const tasksModuleManifest = {
  id: TASKS_MODULE_ID,
  name: "Tasks",
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
      "sql/0003_tasks_module.sql",
      "sql/0019_tasks_owner_or_share.sql",
      "sql/0039_tasks_foundation.sql",
      "sql/0075_tasks_worker_recurrence_grant.sql"
    ],
    migrationDirectories: ["packages/tasks/sql"],
    ownedTables: ["app.tasks", "app.task_activity"]
  },
  navigation: [
    {
      id: "tasks",
      label: "Tasks",
      description:
        "View and manage the active actor's tasks: create, update, and complete tasks, organize them into lists and tags, break a task into subtasks, and see them ranked by priority in the do/schedule/delegate/eliminate matrix.",
      path: "/tasks",
      icon: "check-square",
      order: 10,
      permissionId: "tasks.view"
    }
  ],
  settings: [
    {
      id: "tasks.module-settings",
      label: "Tasks",
      description:
        "Choose whether your assistant can create, update, schedule, and complete tasks from chat without asking first.",
      path: "/settings/modules/tasks",
      scope: "user",
      order: 10,
      permissionId: "tasks.manage",
      entry: "./settings"
    }
  ],
  permissions: [
    {
      id: "tasks.view",
      label: "View tasks",
      description: "Read tasks owned by or shared with the active actor.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "tasks.create",
      label: "Create tasks",
      description: "Create tasks owned by the active actor.",
      scope: "user",
      actions: ["create"]
    },
    {
      id: "tasks.update",
      label: "Update tasks",
      description: "Update tasks owned by or shared with the active actor.",
      scope: "user",
      actions: ["update"]
    },
    {
      id: "tasks.manage",
      label: "Manage tasks module",
      description: "Manage Tasks module settings and behavior.",
      scope: "user",
      actions: ["manage"]
    }
  ],
  featureFlags: [
    {
      id: "tasks.module",
      label: "Tasks module",
      description: "Enables the built-in Tasks module surfaces and routes.",
      scope: "system",
      defaultEnabled: true
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/tasks",
      responseSchema: listTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "POST",
      path: "/api/tasks",
      requestSchema: createTaskRequestSchema,
      responseSchema: createTaskResponseSchema,
      permissionId: "tasks.create"
    },
    {
      method: "POST",
      path: "/api/tasks/search/interpret",
      requestSchema: interpretTaskSearchRequestSchema,
      responseSchema: interpretTaskSearchResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/:id",
      responseSchema: getTaskResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "PATCH",
      path: "/api/tasks/:id",
      requestSchema: updateTaskRequestSchema,
      responseSchema: updateTaskResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/activity",
      requestSchema: addTaskActivityRequestSchema,
      responseSchema: addTaskActivityResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/deferred-status",
      requestSchema: deferredTaskStatusRequestSchema,
      responseSchema: deferredTaskStatusResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/tags",
      requestSchema: assignTaskTagRequestSchema,
      responseSchema: assignTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "DELETE",
      path: "/api/tasks/:id/tags/:tagId",
      responseSchema: unassignTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/lists",
      responseSchema: listTaskListsResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "POST",
      path: "/api/tasks/lists",
      requestSchema: createTaskListRequestSchema,
      responseSchema: createTaskListResponseSchema,
      permissionId: "tasks.create"
    },
    {
      method: "PATCH",
      path: "/api/tasks/lists/:listId",
      requestSchema: renameTaskListRequestSchema,
      responseSchema: renameTaskListRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "DELETE",
      path: "/api/tasks/lists/:listId",
      requestSchema: deleteTaskListRequestSchema,
      responseSchema: deleteTaskListRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/lists/:listId/tags",
      responseSchema: listTaskTagsResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "POST",
      path: "/api/tasks/lists/:listId/tags",
      requestSchema: createTaskTagRequestSchema,
      responseSchema: createTaskTagResponseSchema,
      permissionId: "tasks.create"
    },
    {
      method: "PATCH",
      path: "/api/tasks/lists/:listId/tags/:tagId",
      requestSchema: renameTaskTagRequestSchema,
      responseSchema: renameTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "DELETE",
      path: "/api/tasks/lists/:listId/tags/:tagId",
      responseSchema: deleteTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/breakdown",
      requestSchema: breakdownTaskRequestSchema,
      responseSchema: breakdownTaskResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/focus",
      responseSchema: focusTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/at-risk",
      responseSchema: atRiskTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/overdue",
      responseSchema: overdueTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/preferences",
      permissionId: "tasks.view"
    },
    {
      method: "PATCH",
      path: "/api/tasks/preferences",
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/agency-auto-execute",
      permissionId: "tasks.view"
    },
    {
      method: "PATCH",
      path: "/api/tasks/agency-auto-execute",
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/:id/subtasks",
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/:id/activity",
      permissionId: "tasks.view"
    }
  ],
  jobs: [
    {
      queueName: TASKS_DEFERRED_STATUS_QUEUE,
      payloadSchema: deferredTaskStatusPayloadSchema,
      metadataOnly: true,
      permissionId: "tasks.update"
    }
  ],
  shareableResources: [
    {
      resourceType: "task",
      grantLevels: ["view", "contribute", "manage"]
    }
  ],
  assistantActionFamilies: [
    {
      id: "task_changes",
      label: "Task changes",
      description: "Create, update, and organize tasks and lists.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    },
    {
      id: "task_cleanup",
      label: "Task cleanup",
      description: "Delete lists and tags.",
      defaultTier: "always_confirm",
      allowedTiers: ["always_confirm", "trusted_auto"]
    }
  ],
  assistantTools: [
    {
      name: "tasks.list",
      description:
        "List tasks visible to the actor. Optional filters: listId, tagId, status (todo|done|archived), priority (1–5 integer), dueBefore/dueAfter (ISO 8601 date strings), quadrant (do|schedule|delegate|eliminate — Eisenhower matrix), completedAfter (ISO 8601 date-time — only tasks completed after this instant).",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          listId: { type: "string" },
          tagId: { type: "string" },
          status: { type: "string", enum: ["todo", "done", "archived"] },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          dueBefore: { type: "string" },
          dueAfter: { type: "string" },
          quadrant: { type: "string", enum: ["do", "schedule", "delegate", "eliminate"] },
          completedAfter: { type: "string" }
        }
      },
      outputSchema: taskItemsToolOutputSchema,
      execute: taskListExecute
    },
    {
      name: "tasks.get",
      description:
        "Get a specific task by ID, including its subtasks and up to 10 most recent activity entries.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: { type: "string" }
        }
      },
      execute: taskGetExecute
    },
    {
      name: "tasks.focus",
      description:
        "Get the focus list — the highest-priority tasks to work on today: overdue tasks plus at-risk tasks (Medium+ priority, due within 48 h or do-date past), ranked by priority, urgency, and effort.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: taskItemsToolOutputSchema,
      execute: taskFocusExecute
    },
    {
      name: "tasks.atRisk",
      description:
        "Get tasks at risk of slipping: open, Medium+ priority, due within 48 hours or do-date passed, with no completed subtasks.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: taskItemsToolOutputSchema,
      execute: taskAtRiskExecute
    },
    {
      name: "tasks.overdue",
      description:
        "Get all overdue tasks — open tasks whose due date is in the past, most overdue first.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: taskItemsToolOutputSchema,
      execute: taskOverdueExecute
    },
    {
      name: "tasks.listLists",
      description: "List all task lists owned by the actor, ordered by position then name.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: taskListItemsToolOutputSchema,
      execute: taskListListsExecute
    },
    {
      name: "tasks.listTags",
      description: "List all tags in a given task list.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: {
        type: "object",
        required: ["listId"],
        properties: {
          listId: { type: "string" }
        }
      },
      outputSchema: taskTagItemsToolOutputSchema,
      execute: taskListTagsExecute
    },
    {
      name: "tasks.activity",
      description: "Get the full activity stream for a task, in chronological order.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: { type: "string" }
        }
      },
      execute: taskActivityExecute
    },
    {
      name: "tasks.create",
      description: "Create a task owned by the active actor.",
      permissionId: "tasks.create",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: createTaskRequestSchema,
      outputSchema: taskMutationToolOutputSchema,
      execute: taskCreateExecute
    },
    {
      name: "tasks.update",
      description: "Update non-destructive fields on a task visible to the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskUpdateToolInputSchema,
      outputSchema: taskMutationToolOutputSchema,
      execute: taskUpdateExecute
    },
    {
      name: "tasks.updateStatus",
      description: "Update the status of a task visible to the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        required: ["taskId", "status"],
        properties: {
          taskId: { type: "string" },
          status: taskStatusSchema
        }
      },
      outputSchema: taskMutationToolOutputSchema,
      execute: taskUpdateStatusExecute
    },
    {
      name: "tasks.breakDown",
      description: "Break a task into ordered subtasks.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskBreakdownToolInputSchema,
      outputSchema: taskBreakdownToolOutputSchema,
      execute: taskBreakDownExecute
    },
    {
      name: "tasks.addActivity",
      description: "Add a note or activity entry to a task.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskActivityToolInputSchema,
      outputSchema: taskActivityToolOutputSchema,
      execute: taskAddActivityExecute
    },
    {
      name: "tasks.assignTag",
      description: "Assign a tag to a task.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskTagAssignmentToolInputSchema,
      outputSchema: taskMutationToolOutputSchema,
      execute: taskAssignTagExecute
    },
    {
      name: "tasks.unassignTag",
      description: "Remove a tag from a task.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskTagAssignmentToolInputSchema,
      outputSchema: taskMutationToolOutputSchema,
      execute: taskUnassignTagExecute
    },
    {
      name: "tasks.createList",
      description: "Create a task list owned by the active actor.",
      permissionId: "tasks.create",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: createTaskListRequestSchema,
      outputSchema: taskListMutationToolOutputSchema,
      execute: taskCreateListExecute
    },
    {
      name: "tasks.renameList",
      description: "Rename a task list owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskListRenameToolInputSchema,
      outputSchema: taskListMutationToolOutputSchema,
      execute: taskRenameListExecute
    },
    {
      name: "tasks.createTag",
      description: "Create a tag in a task list owned by the active actor.",
      permissionId: "tasks.create",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskTagCreateToolInputSchema,
      outputSchema: taskTagMutationToolOutputSchema,
      execute: taskCreateTagExecute
    },
    {
      name: "tasks.renameTag",
      description: "Rename a tag owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskTagRenameToolInputSchema,
      outputSchema: taskTagMutationToolOutputSchema,
      execute: taskRenameTagExecute
    },
    {
      name: "tasks.deleteList",
      description: "Delete a task list owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_cleanup",
      selfOperationGrant: "user_promotable",
      inputSchema: taskDeleteListToolInputSchema,
      outputSchema: taskDeleteToolOutputSchema,
      execute: taskDeleteListExecute,
      summarize: (input) => {
        const listId = String(input.listId);
        const reassignToListId =
          typeof input.reassignToListId === "string" ? input.reassignToListId : null;
        return reassignToListId
          ? `Delete task list ${listId}; reassign its tasks to ${reassignToListId}.`
          : `Delete empty task list ${listId}; non-empty lists are rejected unless reassigned.`;
      }
    },
    {
      name: "tasks.deleteTag",
      description: "Delete a task tag owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "task_cleanup",
      selfOperationGrant: "user_promotable",
      inputSchema: taskDeleteTagToolInputSchema,
      outputSchema: taskDeleteToolOutputSchema,
      execute: taskDeleteTagExecute,
      summarize: (input) =>
        `Delete task tag ${String(input.tagId)} from list ${String(
          input.listId
        )}; assignments to that tag will be removed.`
    }
  ],
  proactiveMonitor: tasksMonitorProvider
} satisfies MossModuleManifest;
