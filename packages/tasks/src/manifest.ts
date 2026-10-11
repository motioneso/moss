import {
  taskItemsToolOutputSchema,
  taskListItemsToolOutputSchema,
  taskTagItemsToolOutputSchema,
  taskMutationToolOutputSchema,
  taskBreakdownToolOutputSchema,
  taskActivityToolOutputSchema,
  taskListMutationToolOutputSchema,
  taskTagMutationToolOutputSchema,
  taskUpdateToolInputSchema,
  taskBreakdownToolInputSchema,
  taskActivityToolInputSchema,
  taskTagAssignmentToolInputSchema,
  taskListRenameToolInputSchema,
  taskTagCreateToolInputSchema,
  taskTagRenameToolInputSchema,
  taskDeleteListToolInputSchema,
  taskDeleteTagToolInputSchema,
  taskDeleteToolOutputSchema
} from "./tool-schemas.js";
import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import { taskListTarget, taskTagTarget, taskTagAssignmentTarget } from "./chat-targets.js";
import {
  taskApprovalActions,
  taskApprovalPresentation,
  taskRoutePresentation,
  taskPreferencesPresentation
} from "./approval-presentation.js";
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
  taskStatusSchema,
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
        "View and manage tasks in lists and tags, with subtasks, a List view grouped by priority and a Grid view by importance and urgency. A list index beside the tasks, or a list picker on a phone, chooses the lists shown.",
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
        "Choose which task actions your assistant may perform from chat without asking. Unknown settings stay unavailable; Retry reloads failed reads. Failed refreshes preserve confirmed choices, and failed saves keep the previous value.",
      path: "/settings?section=modules&module=tasks",
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
    // listFiltered rolls recurring series forward before returning the read.
    {
      method: "GET",
      path: "/api/tasks",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: listTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "POST",
      path: "/api/tasks",
      // Recurring creates reconcile the actor's pg-boss schedule.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      requestSchema: createTaskRequestSchema,
      responseSchema: createTaskResponseSchema,
      permissionId: "tasks.create"
    },
    {
      method: "POST",
      path: "/api/tasks/search/interpret",
      // Natural-language interpretation calls the actor's model provider.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      requestSchema: interpretTaskSearchRequestSchema,
      responseSchema: interpretTaskSearchResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/:id",
      chat: { access: "read", coveredBy: "tasks.get" },
      responseSchema: getTaskResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "PATCH",
      path: "/api/tasks/:id",
      // Status changes also train email triage and can suppress future suggested tasks.
      chat: { access: "blocked", blockedBecause: "external_effect", coveredBy: "tasks.update" },
      requestSchema: updateTaskRequestSchema,
      responseSchema: updateTaskResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/activity",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Add task activity",
        presentation: taskRoutePresentation("addActivity", { id: "taskId" }),
        coveredBy: "tasks.addActivity"
      },
      requestSchema: addTaskActivityRequestSchema,
      responseSchema: addTaskActivityResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/deferred-status",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      requestSchema: deferredTaskStatusRequestSchema,
      responseSchema: deferredTaskStatusResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/tags",
      chat: {
        access: "write",
        title: "Assign task tag",
        presentation: taskRoutePresentation("assignTag", { id: "taskId" }),
        coveredBy: "tasks.assignTag"
      },
      requestSchema: assignTaskTagRequestSchema,
      responseSchema: assignTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "DELETE",
      path: "/api/tasks/:id/tags/:tagId",
      chat: {
        access: "destructive",
        title: "Remove tag from task",
        presentation: taskRoutePresentation("unassignTag", { id: "taskId", tagId: "tagId" }),
        coveredBy: "tasks.unassignTag",
        target: taskTagAssignmentTarget
      },
      responseSchema: unassignTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/lists",
      // The page-load read repairs recurrence schedules.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: listTaskListsResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "POST",
      path: "/api/tasks/lists",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Create task list",
        presentation: taskRoutePresentation("createList", {}),
        coveredBy: "tasks.createList"
      },
      requestSchema: createTaskListRequestSchema,
      responseSchema: createTaskListResponseSchema,
      permissionId: "tasks.create"
    },
    {
      method: "PATCH",
      path: "/api/tasks/lists/:listId",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Rename task list",
        presentation: taskRoutePresentation("renameList", { listId: "listId" }),
        coveredBy: "tasks.renameList"
      },
      requestSchema: renameTaskListRequestSchema,
      responseSchema: renameTaskListRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "DELETE",
      path: "/api/tasks/lists/:listId",
      chat: {
        access: "destructive",
        content: "user_authored",
        title: "Delete task list",
        presentation: taskRoutePresentation("deleteList", { listId: "listId" }),
        coveredBy: "tasks.deleteList",
        target: taskListTarget
      },
      requestSchema: deleteTaskListRequestSchema,
      responseSchema: deleteTaskListRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/lists/:listId/tags",
      chat: { access: "read", content: "user_authored", coveredBy: "tasks.listTags" },
      responseSchema: listTaskTagsResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "POST",
      path: "/api/tasks/lists/:listId/tags",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Create task tag",
        presentation: taskRoutePresentation("createTag", { listId: "listId" }),
        coveredBy: "tasks.createTag"
      },
      requestSchema: createTaskTagRequestSchema,
      responseSchema: createTaskTagResponseSchema,
      permissionId: "tasks.create"
    },
    {
      method: "PATCH",
      path: "/api/tasks/lists/:listId/tags/:tagId",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Rename task tag",
        presentation: taskRoutePresentation("renameTag", { listId: "listId", tagId: "tagId" }),
        coveredBy: "tasks.renameTag"
      },
      requestSchema: renameTaskTagRequestSchema,
      responseSchema: renameTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "DELETE",
      path: "/api/tasks/lists/:listId/tags/:tagId",
      chat: {
        access: "destructive",
        content: "user_authored",
        title: "Delete task tag",
        presentation: taskRoutePresentation("deleteTag", { listId: "listId", tagId: "tagId" }),
        coveredBy: "tasks.deleteTag",
        target: taskTagTarget
      },
      responseSchema: deleteTaskTagRouteSchema.response[200],
      permissionId: "tasks.update"
    },
    {
      method: "POST",
      path: "/api/tasks/:id/breakdown",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Break task into subtasks",
        presentation: taskRoutePresentation("breakDown", { id: "taskId" }),
        coveredBy: "tasks.breakDown"
      },
      requestSchema: breakdownTaskRequestSchema,
      responseSchema: breakdownTaskResponseSchema,
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/focus",
      // All three drift reads roll recurring series forward in the database.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: focusTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/at-risk",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: atRiskTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/overdue",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: overdueTasksResponseSchema,
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/preferences",
      // getOrCreate inserts a default preference row when missing.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "tasks.view"
    },
    {
      method: "PATCH",
      path: "/api/tasks/preferences",
      chat: {
        access: "write",
        content: "user_authored",
        title: "Set task view preference",
        presentation: taskPreferencesPresentation
      },
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/agency-auto-execute",
      // Reading the compatibility policy may heal a missing trusted_auto grant.
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "tasks.view"
    },
    {
      method: "PATCH",
      path: "/api/tasks/agency-auto-execute",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "tasks.update"
    },
    {
      method: "GET",
      path: "/api/tasks/:id/subtasks",
      chat: { access: "read", coveredBy: "tasks.get" },
      permissionId: "tasks.view"
    },
    {
      method: "GET",
      path: "/api/tasks/:id/activity",
      chat: { access: "read", coveredBy: "tasks.activity" },
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
      content: "outside",
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
      content: "outside",
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
      content: "outside",
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
      content: "outside",
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
      content: "outside",
      inputSchema: { type: "object", properties: {} },
      outputSchema: taskItemsToolOutputSchema,
      execute: taskOverdueExecute
    },
    {
      name: "tasks.listLists",
      description: "List all task lists owned by the actor, ordered by position then name.",
      permissionId: "tasks.view",
      risk: "read",
      content: "outside",
      inputSchema: { type: "object", properties: {} },
      outputSchema: taskListItemsToolOutputSchema,
      execute: taskListListsExecute
    },
    {
      name: "tasks.listTags",
      description: "List all tags in a given task list.",
      permissionId: "tasks.view",
      risk: "read",
      content: "outside",
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
      content: "outside",
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
      actionLabel: taskApprovalActions.create.label,
      approvalPresentation: taskApprovalPresentation("create"),
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
      actionLabel: taskApprovalActions.update.label,
      approvalPresentation: taskApprovalPresentation("update"),
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
      actionLabel: taskApprovalActions.updateStatus.label,
      approvalPresentation: taskApprovalPresentation("updateStatus"),
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
      actionLabel: taskApprovalActions.breakDown.label,
      approvalPresentation: taskApprovalPresentation("breakDown"),
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
      actionLabel: taskApprovalActions.addActivity.label,
      approvalPresentation: taskApprovalPresentation("addActivity"),
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
      actionLabel: taskApprovalActions.assignTag.label,
      approvalPresentation: taskApprovalPresentation("assignTag"),
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
      actionLabel: taskApprovalActions.unassignTag.label,
      approvalPresentation: taskApprovalPresentation("unassignTag"),
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
      actionLabel: taskApprovalActions.createList.label,
      approvalPresentation: taskApprovalPresentation("createList"),
      description: "Create a task list owned by the active actor.",
      permissionId: "tasks.create",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: createTaskListRequestSchema,
      outputSchema: taskListMutationToolOutputSchema,
      execute: taskCreateListExecute
    },
    {
      name: "tasks.renameList",
      actionLabel: taskApprovalActions.renameList.label,
      approvalPresentation: taskApprovalPresentation("renameList"),
      description: "Rename a task list owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskListRenameToolInputSchema,
      outputSchema: taskListMutationToolOutputSchema,
      execute: taskRenameListExecute
    },
    {
      name: "tasks.createTag",
      actionLabel: taskApprovalActions.createTag.label,
      approvalPresentation: taskApprovalPresentation("createTag"),
      description: "Create a tag in a task list owned by the active actor.",
      permissionId: "tasks.create",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskTagCreateToolInputSchema,
      outputSchema: taskTagMutationToolOutputSchema,
      execute: taskCreateTagExecute
    },
    {
      name: "tasks.renameTag",
      actionLabel: taskApprovalActions.renameTag.label,
      approvalPresentation: taskApprovalPresentation("renameTag"),
      description: "Rename a tag owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      actionFamilyId: "task_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: taskTagRenameToolInputSchema,
      outputSchema: taskTagMutationToolOutputSchema,
      execute: taskRenameTagExecute
    },
    {
      name: "tasks.deleteList",
      actionLabel: taskApprovalActions.deleteList.label,
      approvalPresentation: taskApprovalPresentation("deleteList"),
      description: "Delete a task list owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      content: "user_authored",
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
      actionLabel: taskApprovalActions.deleteTag.label,
      approvalPresentation: taskApprovalPresentation("deleteTag"),
      description: "Delete a task tag owned by the active actor.",
      permissionId: "tasks.update",
      risk: "write",
      content: "user_authored",
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
  features: [
    {
      id: "tasks.approval_effects",
      description:
        "Deleting a list keeps reassigned tasks but deletes its tags and assignments. Moving a task removes tags from other lists; a parent's subtasks follow it. Deleting a tag removes it from all tasks without deleting the tasks."
    },
    {
      id: "tasks.chat_app_actions",
      description:
        "App actions read individual tasks and activity, manage lists and tags, and split tasks. Scheduling, email-triage updates and auto-execution controls remain blocked; dedicated task tools stay separate."
    },
    {
      id: "tasks.lists_and_tags",
      description:
        "Organize tasks into lists and tags, and rename, reassign or delete them without losing tasks. Pick a list from the index or the phone picker; it stays across List and Grid. When nothing matches, Clear filters resets them.",
      errors: [
        {
          code: "tasks.load_failed",
          class: "transient",
          description:
            "Tasks could not load. With nothing loaded the page says so with Retry; after an earlier load it keeps those tasks on screen, says the refresh failed and offers Retry."
        },
        {
          code: "tasks.lists_load_failed",
          class: "transient",
          description:
            "Lists could not load. The list index, or the list picker on a phone, says so and offers Retry."
        },
        {
          code: "tasks.update_failed",
          class: "transient",
          description:
            "Completing, reopening, accepting or dismissing a task failed. The task returns to its previous state and a message asks you to try again."
        }
      ]
    },
    {
      id: "tasks.priority_matrix",
      description:
        "Grid ranks tasks into Do First, Schedule, Delegate and Later by importance and urgency, each a headed section with a count that stays visible when empty. A focus list shows overdue and at-risk tasks for today.",
      errors: [
        {
          code: "tasks.view_load_failed",
          class: "transient",
          description:
            "The saved List or Grid choice could not load, so List shows with a Retry beside the message."
        },
        {
          code: "tasks.view_save_failed",
          class: "transient",
          description:
            "Switching between List and Grid could not be saved. The previous view stays selected and a message says so; press List or Grid again."
        }
      ]
    },
    {
      id: "tasks.details_window",
      description:
        "Open a task from List or Grid in Task details. X, Cancel or Escape discards unsaved field edits; subtasks, tags and comments save as you go. Each read distinguishes loading and failure with Retry; refresh failure keeps loaded fields."
    },
    {
      id: "tasks.details_save",
      description:
        "Save changes waits for the task to load. Failed saves keep edits; adding again resumes without duplicating. Repeats shows the stored repeat. Failed comment, tag and subtask writes explain the error beside the action and keep draft text."
    },
    {
      id: "tasks.breakdown",
      description:
        "Turn a big task into ordered subtasks, so one task becomes a list of next steps."
    },
    {
      id: "tasks.due_and_recurrence",
      description:
        "Set due dates, effort estimates and recurrence; recurring tasks roll forward each day, " +
        "and incomplete ones show in the overdue list."
    },
    {
      id: "tasks.natural_language_search",
      description:
        "Describe what you are looking for in your own words; Tasks interprets it into a filtered " +
        "search of your tasks."
    }
  ],
  proactiveMonitor: tasksMonitorProvider
} satisfies MossModuleManifest;
