// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "@moss/shared";
import { TaskDetailsDialog } from "../../apps/web/src/tasks/task-details-dialog.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
const api = vi.hoisted(() => ({
  getTask: vi.fn(),
  listSubtasks: vi.fn(),
  listTaskActivity: vi.fn(),
  listTaskTags: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  breakdownTask: vi.fn(),
  createTaskTag: vi.fn(),
  assignTaskTag: vi.fn(),
  unassignTaskTag: vi.fn(),
  addTaskActivity: vi.fn()
}));
vi.mock("../../apps/web/src/api/client.js", () => ({
  ...api,
  getLocaleSettings: vi.fn(() => new Promise(() => undefined))
}));
const task: TaskDto = {
  id: "task-design",
  ownerUserId: "user-design",
  listId: "list-design",
  parentTaskId: null,
  title: "Prepare the project notes",
  description: "Keep the saved context",
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
  suggestionMetadata: null
};
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getTask.mockResolvedValue({ task });
  api.listSubtasks.mockResolvedValue({ tasks: [] });
  api.listTaskActivity.mockResolvedValue({ activity: [] });
  api.listTaskTags.mockResolvedValue({ tags: [] });
  api.createTaskTag.mockResolvedValue({ tag: { id: "tag-design" } });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskDetailsDialog
          open
          taskId={task.id}
          currentUserLabel="Owner"
          lists={[]}
          onClose={() => undefined}
        />
      </QueryClientProvider>
    )
  );
}
async function eventually(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    check();
  });
}
function button(name: string) {
  const value = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === name || item.getAttribute("aria-label") === name
  );
  if (!value) throw new Error(`Missing button: ${name}`);
  return value;
}
function type(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!field) throw new Error(`Missing field: ${selector}`);
  act(() => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field;
}
function enter(field: HTMLElement) {
  act(() =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    )
  );
}
describe("task details truthful recovery", () => {
  it("announces the initial detail load without blank editable fields or false empty activity", async () => {
    api.getTask.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(container.textContent).toContain("Loading task details…");
    expect(container.textContent).not.toContain("No activity yet");
    expect(container.querySelector("#task-notes-input")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.disabled).toBe(
      true
    );
    expect(button("Save changes").disabled).toBe(true);
  });
  it("offers an initial detail retry and restores the saved form", async () => {
    api.getTask.mockRejectedValueOnce(new Error("Unavailable"));
    await render();
    await eventually(() => expect(container.textContent).toContain("Could not load this task"));
    expect(button("Save changes").disabled).toBe(true);
    act(() => button("Retry task").click());
    await eventually(() =>
      expect(container.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe(
        task.title
      )
    );
    expect(button("Save changes").disabled).toBe(false);
  });
  it("distinguishes activity and subtask failures and lets each section retry", async () => {
    api.listTaskActivity.mockRejectedValueOnce(new Error("Activity unavailable"));
    api.listSubtasks.mockRejectedValueOnce(new Error("Subtasks unavailable"));
    await render();
    await eventually(() => expect(container.textContent).toContain("Could not load activity"));
    expect(container.textContent).toContain("Could not load subtasks");
    expect(container.textContent).not.toContain("No activity yet");
    act(() => {
      button("Retry activity").click();
      button("Retry subtasks").click();
    });
    await eventually(() => expect(container.textContent).toContain("No activity yet"));
    expect(container.textContent).not.toContain("Could not load subtasks");
  });
  it("retains comment, tag and subtask input when their writes fail", async () => {
    api.addTaskActivity.mockRejectedValue(new Error("Write unavailable"));
    api.assignTaskTag.mockRejectedValue(new Error("Write unavailable"));
    api.breakdownTask.mockRejectedValue(new Error("Write unavailable"));
    await render();
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    const comment = type('textarea[placeholder="Add a comment…"]', "Keep my comment");
    act(() => button("Post comment").click());
    const tag = type('input[aria-label="Add a tag"]', "planning");
    enter(tag);
    const sub = type('input[placeholder="Add a subtask and press Enter"]', "Keep my subtask");
    enter(sub);
    await eventually(() => expect(container.textContent).toContain("Could not post your comment"));
    await eventually(() => expect(container.textContent).toContain("Could not update tags"));
    expect(container.textContent).toContain("Could not update the subtask");
    expect(comment.value).toBe("Keep my comment");
    expect(tag.value).toBe("planning");
    expect(sub.value).toBe("Keep my subtask");
  });
  it("keeps unsaved edits visible when a background refresh fails", async () => {
    await render();
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    type('[aria-label="Task title"]', "Unsaved title");
    api.getTask.mockRejectedValue(new Error("Refresh unavailable"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.tasks.detail(task.id) });
    });
    await eventually(() => expect(container.textContent).toContain("Could not refresh this task"));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe(
      "Unsaved title"
    );
    expect(container.querySelector("#task-notes-input")).not.toBeNull();
  });
});
