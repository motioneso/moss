import { assertDataContextDb, withSavepoint, type DataContextDb, type Task } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";

import { TaskBreakdownRepository } from "./breakdown.js";
import { TaskDriftRepository } from "./drift.js";
import { TaskListsRepository } from "./lists.js";
import { TasksRepository, type CreateTaskInput, type UpdateTaskInput } from "./repository.js";
import { readTaskSummary } from "./summary/repository.js";
import { taskSummaryData } from "./summary/tool.js";
import {
  serializeTask,
  serializeTaskActivity,
  serializeTaskList,
  serializeTaskTag
} from "./serialize.js";

const repository = new TasksRepository();
const drift = new TaskDriftRepository();
const lists = new TaskListsRepository();
const breakdown = new TaskBreakdownRepository();

export async function authorizeTaskBackgroundRead(
  scopedDb: DataContextDb,
  input: Record<string, unknown>,
  ctx: { readonly actorUserId: string }
): Promise<boolean> {
  if (Object.keys(input).length !== 1 || typeof input.taskId !== "string") return false;
  const task = await repository.getById(scopedDb, input.taskId);
  return task?.owner_user_id === ctx.actorUserId;
}

/** Bounded owner-only candidates; listing never advances recurring series. */
export async function listOwnedTasksForScheduledRead(scopedDb: DataContextDb) {
  assertDataContextDb(scopedDb);
  return repository.listOwnedReadCandidates(scopedDb);
}

async function taskData(scopedDb: DataContextDb, task: Task) {
  const tags = await repository.getTagsForTask(scopedDb, task.id);
  return serializeTask(task, tags);
}

function statusSummary(status: "todo" | "done" | "archived", title: string): string {
  if (status === "done") return `Completed task: ${title}`;
  if (status === "archived") return `Archived task: ${title}`;
  return `Reopened task: ${title}`;
}

export const taskListExecute: ToolExecute = async (scopedDb, input, _ctx): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);

  const { listId, tagId, status, priority, dueBefore, dueAfter, quadrant, completedAfter } =
    input as {
      listId?: string;
      tagId?: string;
      status?: string;
      priority?: number;
      dueBefore?: string;
      dueAfter?: string;
      quadrant?: string;
      completedAfter?: string;
    };

  const tasks = await repository.listFiltered(scopedDb, {
    listId,
    tagId,
    status: status === "todo" || status === "done" || status === "archived" ? status : undefined,
    priority,
    dueBefore: dueBefore ? new Date(dueBefore) : undefined,
    dueAfter: dueAfter ? new Date(dueAfter) : undefined,
    completedAfter: completedAfter ? new Date(completedAfter) : undefined,
    quadrant:
      quadrant === "do" ||
      quadrant === "schedule" ||
      quadrant === "delegate" ||
      quadrant === "eliminate"
        ? quadrant
        : undefined
  });

  const tagMap = await repository.getTagsForTasks(
    scopedDb,
    tasks.map((t) => t.id)
  );
  return {
    data: { items: tasks.map((task) => serializeTask(task, tagMap.get(task.id) ?? [])) },
    columnOrder: ["id", "title", "status", "dueAt", "priority"]
  };
};

export const taskGetExecute: ToolExecute = async (scopedDb, input, _ctx): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);

  const { taskId } = input as { taskId: string };

  const [task, subtasks, activity] = await Promise.all([
    repository.getById(scopedDb, taskId),
    repository.listByParentId(scopedDb, taskId),
    repository.listActivity(scopedDb, taskId)
  ]);

  if (!task) {
    return { data: { error: "Task not found" } };
  }

  const [tags, subtaskTagMap] = await Promise.all([
    repository.getTagsForTask(scopedDb, taskId),
    repository.getTagsForTasks(
      scopedDb,
      subtasks.map((s) => s.id)
    )
  ]);

  return {
    data: {
      task: serializeTask(task, tags),
      subtasks: subtasks.map((s) => serializeTask(s, subtaskTagMap.get(s.id) ?? [])),
      activity: activity.slice(-10).map(serializeTaskActivity)
    }
  };
};

export const taskFocusExecute: ToolExecute = async (
  scopedDb,
  _input,
  ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const tasks = await drift.getFocus(scopedDb);
  const tagMap = await repository.getTagsForTasks(
    scopedDb,
    tasks.map((t) => t.id)
  );
  // Focus retains its existing ranking and recurrence reconciliation. Its optional
  // today context is an independent bounded summary, never a relabeling of Focus rows.
  let todayContext;
  if (services?.visualPresentation) {
    try {
      const summary = await withSavepoint(scopedDb, () => readTaskSummary(scopedDb, "today"));
      const data = taskSummaryData(summary, ctx, services);
      todayContext = data.presentation
        ? data
        : { ...data, unavailable: "Visual presentation unavailable; summary remains readable." };
    } catch {
      todayContext = { unavailable: "Today summary unavailable; Focus items remain available." };
    }
  }
  return {
    data: {
      ...(todayContext ? { todayContext } : {}),
      items: tasks.map((task) => serializeTask(task, tagMap.get(task.id) ?? []))
    },
    columnOrder: ["id", "title", "status", "dueAt", "priority"]
  };
};

export const taskAtRiskExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const tasks = await drift.getAtRisk(scopedDb);
  const tagMap = await repository.getTagsForTasks(
    scopedDb,
    tasks.map((t) => t.id)
  );
  return {
    data: { items: tasks.map((task) => serializeTask(task, tagMap.get(task.id) ?? [])) },
    columnOrder: ["id", "title", "status", "dueAt", "priority"]
  };
};

export const taskOverdueExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const tasks = await drift.getOverdue(scopedDb);
  const tagMap = await repository.getTagsForTasks(
    scopedDb,
    tasks.map((t) => t.id)
  );
  return {
    data: { items: tasks.map((task) => serializeTask(task, tagMap.get(task.id) ?? [])) },
    columnOrder: ["id", "title", "status", "dueAt", "priority"]
  };
};

export const taskListListsExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const taskLists = await lists.list(scopedDb);
  return { data: { items: taskLists.map(serializeTaskList) } };
};

export const taskListTagsExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { listId } = input as { listId: string };
  const tags = await lists.listTags(scopedDb, listId);
  return { data: { items: tags.map(serializeTaskTag) } };
};

export const taskActivityExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { taskId } = input as { taskId: string };
  const activity = await repository.listActivity(scopedDb, taskId);
  return { data: { items: activity.map(serializeTaskActivity) } };
};

export const taskCreateExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const task = await repository.create(scopedDb, input as unknown as CreateTaskInput);
  return { data: { summary: `Created task: ${task.title}`, task: await taskData(scopedDb, task) } };
};

export const taskUpdateExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { taskId, ...updates } = input as unknown as { taskId: string } & UpdateTaskInput;
  const task = await repository.update(scopedDb, taskId, updates);
  if (!task) return { data: { error: "Task not found" } };
  return { data: { summary: `Updated task: ${task.title}`, task: await taskData(scopedDb, task) } };
};

export const taskUpdateStatusExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);

  const { taskId, status } = input as { taskId: string; status: unknown };
  if (status !== "todo" && status !== "done" && status !== "archived") {
    return { data: { error: "Invalid status" } };
  }

  const task = await repository.updateStatus(scopedDb, taskId, status);
  if (!task) {
    return { data: { error: "Task not found" } };
  }

  return {
    data: { summary: statusSummary(status, task.title), task: await taskData(scopedDb, task) }
  };
};

export const taskBreakDownExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { taskId, steps } = input as { taskId: string; steps: string[] };
  const tasks = await breakdown.breakDown(scopedDb, taskId, steps);
  return {
    data: {
      summary: `Added ${tasks.length} subtask${tasks.length === 1 ? "" : "s"}.`,
      tasks: tasks.map((task) => serializeTask(task))
    }
  };
};

export const taskAddActivityExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { taskId, activityType, body } = input as {
    taskId: string;
    activityType?: string;
    body?: string | null;
  };
  const task = await repository.getById(scopedDb, taskId);
  if (!task) return { data: { error: "Task not found" } };
  const activity = await repository.addActivity(scopedDb, taskId, {
    activityType: activityType ?? "comment",
    body
  });
  return {
    data: {
      summary: `Added note/activity to ${task.title}.`,
      activity: serializeTaskActivity(activity)
    }
  };
};

export const taskAssignTagExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { taskId, tagId } = input as { taskId: string; tagId: string };
  await lists.assignTag(scopedDb, taskId, tagId);
  const task = await repository.getById(scopedDb, taskId);
  if (!task) return { data: { error: "Task not found" } };
  const tags = await repository.getTagsForTask(scopedDb, taskId);
  const tag = tags.find((candidate) => candidate.id === tagId);
  return {
    data: {
      summary: `Assigned tag ${tag?.name ?? tagId}.`,
      task: serializeTask(task, tags)
    }
  };
};

export const taskUnassignTagExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { taskId, tagId } = input as { taskId: string; tagId: string };
  const tag = await scopedDb.db
    .selectFrom("app.task_tags")
    .select(["id", "name"])
    .where("id", "=", tagId)
    .executeTakeFirst();
  await lists.unassignTag(scopedDb, taskId, tagId);
  const task = await repository.getById(scopedDb, taskId);
  if (!task) return { data: { error: "Task not found" } };
  return {
    data: {
      summary: `Removed tag ${tag?.name ?? tagId}.`,
      task: await taskData(scopedDb, task)
    }
  };
};

export const taskCreateListExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { name } = input as { name: string };
  const list = await lists.getOrCreate(scopedDb, name);
  return { data: { summary: `Created task list: ${list.name}`, list: serializeTaskList(list) } };
};

export const taskRenameListExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { listId, name } = input as { listId: string; name: string };
  const list = await lists.renameList(scopedDb, listId, name);
  return { data: { summary: `Renamed task list: ${list.name}`, list: serializeTaskList(list) } };
};

export const taskCreateTagExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { listId, name } = input as { listId: string; name: string };
  const tag = await lists.createTag(scopedDb, listId, name);
  return { data: { summary: `Created tag ${tag.name}.`, tag: serializeTaskTag(tag) } };
};

export const taskRenameTagExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { listId, tagId, name } = input as { listId: string; tagId: string; name: string };
  const tag = await lists.renameTag(scopedDb, listId, tagId, name);
  return { data: { summary: `Renamed tag ${tag.name}.`, tag: serializeTaskTag(tag) } };
};

export const taskDeleteListExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { listId, reassignToListId } = input as {
    listId: string;
    reassignToListId?: string;
  };
  await lists.deleteList(scopedDb, listId, reassignToListId);
  return { data: { summary: "Deleted task list.", deleted: true } };
};

export const taskDeleteTagExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { listId, tagId } = input as { listId: string; tagId: string };
  await lists.deleteTag(scopedDb, listId, tagId);
  return { data: { summary: "Deleted task tag.", deleted: true } };
};
