import type { Task, TaskActivity, TaskList, TaskPreferences, TaskTag } from "@moss/db";
import type {
  TaskActivityDto,
  TaskDto,
  TaskListDto,
  TaskPreferencesDto,
  TaskTagDto
} from "@moss/shared";
import type { TaskSuggestionMetadataV1 } from "@moss/shared";

import { parseRecurrenceSpec } from "./recurrence.js";

export function serializeDate(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeTaskList(list: TaskList): TaskListDto {
  return {
    id: list.id,
    ownerUserId: list.owner_user_id,
    name: list.name,
    position: list.position,
    createdAt: serializeDate(list.created_at),
    updatedAt: serializeDate(list.updated_at)
  };
}

export function serializeTaskTag(tag: TaskTag): TaskTagDto {
  return {
    id: tag.id,
    ownerUserId: tag.owner_user_id,
    listId: tag.list_id,
    name: tag.name,
    createdAt: serializeDate(tag.created_at)
  };
}

export function serializeTask(task: Task, tags: readonly TaskTag[] = []): TaskDto {
  return {
    id: task.id,
    ownerUserId: task.owner_user_id,
    listId: task.list_id,
    parentTaskId: task.parent_task_id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    position: task.position,
    dueAt: serializeDate(task.due_at),
    doAt: serializeDate(task.do_at),
    effort: task.effort,
    source: task.source,
    sourceRef: task.source_ref,
    completedAt: serializeDate(task.completed_at),
    createdAt: serializeDate(task.created_at),
    updatedAt: serializeDate(task.updated_at),
    tags: tags.map(serializeTaskTag),
    suggestionMetadata: task.suggestion_metadata as TaskSuggestionMetadataV1 | null,
    recurrence: parseRecurrenceSpec(task.recurrence)
  };
}

export function serializeTaskPreferences(prefs: TaskPreferences): TaskPreferencesDto {
  return {
    defaultView: prefs.default_view as "priority" | "matrix",
    updatedAt: serializeDate(prefs.updated_at ?? null)
  };
}

export function serializeTaskActivity(activity: TaskActivity): TaskActivityDto {
  return {
    id: activity.id,
    taskId: activity.task_id,
    actorUserId: activity.actor_user_id,
    activityType: activity.activity_type,
    body: activity.body,
    createdAt: serializeDate(activity.created_at)
  };
}
