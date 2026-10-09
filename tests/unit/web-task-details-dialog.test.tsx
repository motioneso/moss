// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskDto } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { TaskDetailsDialog } from "../../apps/web/src/tasks/task-details-dialog.js";

const api = vi.hoisted(() => ({
  getTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  breakdownTask: vi.fn()
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  getTask: api.getTask,
  createTask: api.createTask,
  updateTask: api.updateTask,
  breakdownTask: api.breakdownTask,
  listSubtasks: vi.fn(async () => ({ tasks: [] })),
  listTaskActivity: vi.fn(async () => ({ activity: [] })),
  listTaskTags: vi.fn(async () => ({ tags: [] })),
  createTaskTag: vi.fn(),
  assignTaskTag: vi.fn(),
  unassignTaskTag: vi.fn(),
  addTaskActivity: vi.fn(),
  getLocaleSettings: vi.fn(() => new Promise(() => undefined))
}));

function storedTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task-1",
    ownerUserId: "user-1",
    listId: "list-1",
    parentTaskId: null,
    title: "Renew passport",
    description: "Bring photos",
    status: "todo",
    priority: 3,
    position: 0,
    dueAt: null,
    doAt: null,
    effort: null,
    source: "manual",
    sourceRef: null,
    completedAt: null,
    createdAt: null,
    updatedAt: null,
    tags: [],
    suggestionMetadata: null,
    ...overrides
  };
}

let renderer: ReactTestRenderer | null = null;

async function mount(taskId: string | null, queryClient: QueryClient) {
  const { act, create } = await import("react-test-renderer");
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TaskDetailsDialog, {
          open: true,
          taskId,
          defaultListId: "list-1",
          currentUserLabel: "Ben",
          lists: [],
          onClose: () => undefined
        })
      )
    );
  });
  return act;
}

function titleInput(): ReactTestInstance {
  return renderer!.root.findByProps({ "aria-label": "Task title" });
}

function button(label: string): ReactTestInstance {
  return renderer!.root.find(
    (node) => node.type === "button" && node.children.some((child) => child === label)
  );
}

describe("task details dialog", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.values(api).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.unstubAllGlobals();
  });

  it("does not let Save run before the existing task has loaded", async () => {
    api.getTask.mockReturnValue(new Promise(() => undefined));
    await mount("task-1", new QueryClient());

    expect(button("Save changes").props.disabled).toBe(true);
  });

  it("keeps unsaved edits when the same task is refreshed", async () => {
    api.getTask.mockResolvedValue({ task: storedTask() });
    const queryClient = new QueryClient();
    const act = await mount("task-1", queryClient);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(titleInput().props.value).toBe("Renew passport");

    await act(async () => {
      titleInput().props.onChange({ target: { value: "Renew passport today" } });
    });
    await act(async () => {
      queryClient.setQueryData(queryKeys.tasks.detail("task-1"), {
        task: storedTask({
          tags: [
            { id: "tag-1", ownerUserId: "user-1", listId: "list-1", name: "home", createdAt: null }
          ]
        })
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(titleInput().props.value).toBe("Renew passport today");
  });

  it("resumes a partly failed new-task save without creating the parent twice", async () => {
    api.createTask.mockResolvedValue({ task: storedTask({ id: "created-1" }) });
    api.breakdownTask.mockRejectedValueOnce(new Error("network")).mockResolvedValue({});
    const act = await mount(null, new QueryClient());

    await act(async () => {
      renderer!.root
        .find((node) => node.type === "button" && node.props.className === "tk-sub__add")
        .props.onClick();
    });
    await act(async () => {
      renderer!.root.findByProps({ placeholder: "Subtask" }).props.onChange({
        target: { value: "Book photographer" }
      });
    });

    await act(async () => {
      button("Add task").props.onClick();
    });
    await act(async () => {
      button("Add task").props.onClick();
    });

    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.breakdownTask).toHaveBeenCalledTimes(2);
  });
});
