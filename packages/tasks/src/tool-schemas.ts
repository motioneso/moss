import {
  taskDtoSchema,
  taskListDtoSchema,
  taskTagDtoSchema,
  addTaskActivityResponseSchema,
  updateTaskRequestSchema,
  breakdownTaskRequestSchema,
  addTaskActivityRequestSchema
} from "@moss/shared";

export const taskItemsToolOutputSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: taskDtoSchema }
  }
} as const;

export const taskListItemsToolOutputSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: taskListDtoSchema }
  }
} as const;

export const taskTagItemsToolOutputSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: taskTagDtoSchema }
  }
} as const;

export const taskMutationToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    task: taskDtoSchema,
    error: { type: "string" }
  }
} as const;

export const taskBreakdownToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tasks: { type: "array", items: taskDtoSchema },
    error: { type: "string" }
  }
} as const;

export const taskActivityToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    activity: addTaskActivityResponseSchema.properties.activity,
    error: { type: "string" }
  }
} as const;

export const taskListMutationToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    list: taskListDtoSchema,
    error: { type: "string" }
  }
} as const;

export const taskTagMutationToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    tag: taskTagDtoSchema,
    error: { type: "string" }
  }
} as const;

export const taskUpdateToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: {
    taskId: { type: "string" },
    ...updateTaskRequestSchema.properties
  }
} as const;

export const taskBreakdownToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "steps"],
  properties: {
    taskId: { type: "string" },
    steps: breakdownTaskRequestSchema.properties.steps
  }
} as const;

export const taskActivityToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: {
    taskId: { type: "string" },
    ...addTaskActivityRequestSchema.properties
  }
} as const;

export const taskTagAssignmentToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "tagId"],
  properties: {
    taskId: { type: "string" },
    tagId: { type: "string" }
  }
} as const;

export const taskListRenameToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "name"],
  properties: {
    listId: { type: "string" },
    name: { type: "string" }
  }
} as const;

export const taskTagCreateToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "name"],
  properties: {
    listId: { type: "string" },
    name: { type: "string" }
  }
} as const;

export const taskTagRenameToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "tagId", "name"],
  properties: {
    listId: { type: "string" },
    tagId: { type: "string" },
    name: { type: "string" }
  }
} as const;

export const taskDeleteListToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId"],
  properties: {
    listId: { type: "string" },
    reassignToListId: { type: "string" }
  }
} as const;

export const taskDeleteTagToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "tagId"],
  properties: {
    listId: { type: "string" },
    tagId: { type: "string" }
  }
} as const;

export const taskDeleteToolOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    deleted: { type: "boolean" },
    error: { type: "string" }
  }
} as const;
