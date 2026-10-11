import { assertDataContextDb, isUuid } from "@moss/db";
import {
  approvalChoice,
  approvalNumber,
  approvalText,
  presentApprovalFields,
  type ApprovalFieldMap,
  type ApprovalFieldPresenter,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";

const nullable =
  (present: ApprovalFieldPresenter): ApprovalFieldPresenter =>
  (value) =>
    value === null ? "None" : present(value);
const status = {
  label: "Status",
  present: approvalChoice({ todo: "To do", done: "Done", archived: "Archived" })
};
const name = { label: "Name", present: approvalText };
const taskFields: ApprovalFieldMap = {
  title: { label: "Title", present: approvalText },
  description: { label: "Description", present: nullable(approvalText) },
  status,
  priority: { label: "Priority", present: nullable(approvalNumber) },
  dueAt: { label: "Due at", present: nullable(approvalText) },
  doAt: { label: "Do at", present: nullable(approvalText) },
  effort: {
    label: "Effort",
    present: nullable(approvalChoice({ quick: "Quick", medium: "Medium", large: "Large" }))
  },
  recurrence: {
    label: "Recurrence",
    present: (value) =>
      value === null
        ? "None"
        : presentApprovalFields(
            value,
            {
              freq: {
                label: "Repeat frequency",
                present: approvalChoice({ daily: "Daily", weekly: "Weekly", monthly: "Monthly" })
              },
              interval: { label: "Repeat interval", present: approvalNumber },
              occurrence_date: { label: "Occurrence date", present: approvalText }
            },
            ["freq", "interval", "occurrence_date"]
          )
  }
};

const references = {
  taskId: { kind: "task", label: "Task" },
  parentTaskId: { kind: "task", label: "Parent task", nullable: true },
  listId: { kind: "list", label: "List" },
  reassignToListId: { kind: "list", label: "Move tasks to list" },
  tagId: { kind: "tag", label: "Tag" }
} as const;
type Reference = keyof typeof references;

export const taskApprovalActions = {
  create: {
    label: "Create task",
    target: "Your tasks",
    fields: taskFields,
    refs: ["listId", "parentTaskId"],
    required: ["title"]
  },
  update: {
    label: "Update task",
    target: "taskId",
    fields: taskFields,
    refs: ["taskId", "listId", "parentTaskId"],
    required: ["taskId"]
  },
  updateStatus: {
    label: "Change task status",
    target: "taskId",
    fields: { status },
    refs: ["taskId"],
    required: ["taskId", "status"]
  },
  breakDown: {
    label: "Break task into subtasks",
    target: "taskId",
    fields: {
      steps: {
        label: "Subtasks",
        present: (value: unknown) =>
          Array.isArray(value) && value.every((item) => typeof item === "string")
            ? value.length
              ? value.map((item, index) => ({
                  label: `Subtask ${index + 1}`,
                  value: item as string
                }))
              : "No subtasks"
            : null
      }
    },
    refs: ["taskId"],
    required: ["taskId", "steps"]
  },
  addActivity: {
    label: "Add task activity",
    target: "taskId",
    fields: {
      activityType: { label: "Activity type", present: approvalText },
      body: { label: "Text", present: nullable(approvalText) }
    },
    refs: ["taskId"],
    required: ["taskId"]
  },
  assignTag: {
    label: "Assign task tag",
    target: "taskId",
    fields: {},
    refs: ["taskId", "tagId"],
    required: ["taskId", "tagId"]
  },
  unassignTag: {
    label: "Remove tag from task",
    target: "taskId",
    fields: {},
    refs: ["taskId", "tagId"],
    required: ["taskId", "tagId"]
  },
  createList: {
    label: "Create task list",
    target: "Your task lists",
    fields: { name },
    refs: [],
    required: ["name"]
  },
  renameList: {
    label: "Rename task list",
    target: "listId",
    fields: { name },
    refs: ["listId"],
    required: ["listId", "name"]
  },
  deleteList: {
    label: "Delete task list",
    target: "listId",
    fields: {},
    refs: ["listId", "reassignToListId"],
    required: ["listId"]
  },
  createTag: {
    label: "Create task tag",
    target: "listId",
    fields: { name },
    refs: ["listId"],
    required: ["listId", "name"]
  },
  renameTag: {
    label: "Rename task tag",
    target: "tagId",
    fields: { name },
    refs: ["listId", "tagId"],
    required: ["listId", "tagId", "name"]
  },
  deleteTag: {
    label: "Delete task tag",
    target: "tagId",
    fields: {},
    refs: ["listId", "tagId"],
    required: ["listId", "tagId"]
  }
} as const satisfies Record<
  string,
  {
    label: string;
    target: string;
    fields: ApprovalFieldMap;
    refs: readonly Reference[];
    required: readonly string[];
  }
>;
export type TaskApprovalAction = keyof typeof taskApprovalActions;

/** Describe existing delete/move cascades without changing execution or approval authority. */
function taskEffects(action: TaskApprovalAction, input: Readonly<Record<string, unknown>>) {
  if (action === "deleteList")
    return [
      {
        label: "Tasks",
        value:
          input.reassignToListId !== undefined
            ? "Move all tasks to the selected destination list; the tasks are kept."
            : "Only an empty list can be deleted. A list that still contains tasks is left unchanged."
      },
      {
        label: "Tags",
        value: "Delete every tag in this list and remove their assignments from tasks."
      },
      { label: "Restriction", value: "Your only remaining task list cannot be deleted." }
    ];
  if (action === "deleteTag")
    return [
      {
        label: "Effect",
        value: "Delete this tag and remove it from every task. The tasks are kept."
      }
    ];
  if (action === "update" && input.listId !== undefined)
    return [
      {
        label: "Tags",
        value:
          "Remove this task's tag assignments that do not belong to the selected destination list."
      }
    ];
  return [];
}

export function taskApprovalPresentation(action: TaskApprovalAction): ToolApprovalPresentation {
  const declaration = taskApprovalActions[action];
  return async (db, input) => {
    assertDataContextDb(db);
    const fields: Record<string, ApprovalFieldMap[string]> = { ...declaration.fields };
    const versions: unknown[] = [];
    const labels: Record<string, string> = {};
    for (const key of declaration.refs as readonly Reference[]) {
      const reference = references[key];
      const id = input[key];
      if (id === undefined && !Object.hasOwn(input, key)) continue;
      if (id === null && key === "parentTaskId") {
        fields[key] = {
          label: reference.label,
          present: (value) => (value === null ? "None" : null)
        };
        continue;
      }
      if (typeof id !== "string" || !isUuid(id)) return null;
      let label: string | undefined;
      if (reference.kind === "task") {
        const row = await db.db
          .selectFrom("app.tasks")
          .select(["id", "title", "updated_at"])
          .where("id", "=", id)
          .executeTakeFirst();
        label = row?.title;
        versions.push(row);
      } else if (reference.kind === "list") {
        const row = await db.db
          .selectFrom("app.task_lists")
          .select(["id", "name"])
          .where("id", "=", id)
          .executeTakeFirst();
        label = row?.name;
        versions.push(row);
      } else {
        let query = db.db
          .selectFrom("app.task_tags")
          .select(["id", "name", "list_id"])
          .where("id", "=", id);
        if (typeof input.listId === "string") query = query.where("list_id", "=", input.listId);
        const row = await query.executeTakeFirst();
        label = row?.name;
        versions.push(row);
      }
      if (!label) return null;
      labels[key] = label;
      fields[key] = { label: reference.label, present: (value) => (value === id ? label! : null) };
    }
    const presented = presentApprovalFields(input, fields, declaration.required);
    if (!presented) return null;
    return {
      content: versions.length ? "outside" : "user_authored",
      target: labels[declaration.target] ?? declaration.target,
      fields: [...presented, ...taskEffects(action, input)],
      version: JSON.stringify(versions)
    };
  };
}

/** Route parameters are explicit inputs too: reject extra keys and body/parameter collisions. */
export function taskRoutePresentation(
  action: TaskApprovalAction,
  params: Readonly<Record<string, Reference>> = {}
): RouteApprovalPresentation {
  const present = taskApprovalPresentation(action);
  return async (db, input, ctx) => {
    if (input.query && Object.keys(input.query).length) return null;
    if (
      input.body !== undefined &&
      (input.body === null || typeof input.body !== "object" || Array.isArray(input.body))
    )
      return null;
    if (Object.keys(input.params).some((key) => !Object.hasOwn(params, key))) return null;
    const values = { ...(input.body as Record<string, unknown> | undefined) };
    for (const [key, reference] of Object.entries(params)) {
      if (!Object.hasOwn(input.params, key) || Object.hasOwn(values, reference)) return null;
      values[reference] = input.params[key];
    }
    return present(db, values, ctx);
  };
}

export const taskPreferencesPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  const fields = presentApprovalFields(
    input.body,
    {
      defaultView: {
        label: "Default task view",
        present: approvalChoice({ priority: "List", matrix: "Grid" })
      }
    },
    ["defaultView"]
  );
  return fields ? { content: "user_authored", target: "Your task preferences", fields } : null;
};
