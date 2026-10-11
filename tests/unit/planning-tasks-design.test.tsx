// @vitest-environment jsdom
import { act, StrictMode } from "react";
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
async function render(taskId: string | null = task.id, onClose: () => void = () => undefined) {
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <TaskDetailsDialog
            open
            taskId={taskId}
            currentUserLabel="Owner"
            lists={[]}
            onClose={onClose}
          />
        </QueryClientProvider>
      </StrictMode>
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
  it("focuses the title after a delayed read when loading focus is untouched", async () => {
    let resolveTask!: (value: { task: TaskDto }) => void;
    api.getTask.mockReturnValue(
      new Promise((resolve) => {
        resolveTask = resolve;
      })
    );
    await render();
    const dialog = container.querySelector('[role="dialog"]');
    expect(document.activeElement).toBe(dialog);
    await act(async () => resolveTask({ task }));
    await eventually(() =>
      expect(document.activeElement).toBe(container.querySelector('[aria-label="Task title"]'))
    );
    expect(container.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe(
      task.title
    );
  });
  it("does not steal focus chosen during loading or overwrite later title edits", async () => {
    let resolveTask!: (value: { task: TaskDto }) => void;
    api.getTask.mockReturnValue(
      new Promise((resolve) => {
        resolveTask = resolve;
      })
    );
    await render();
    const cancel = button("Cancel");
    cancel.focus();
    await act(async () => resolveTask({ task }));
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    expect(document.activeElement).toBe(cancel);
    type('[aria-label="Task title"]', "My unsaved title");
    const notes = container.querySelector<HTMLTextAreaElement>("#task-notes-input")!;
    notes.focus();
    await act(async () => {
      client.setQueryData(queryKeys.tasks.detail(task.id), {
        task: { ...task, title: "Refreshed server title" }
      });
    });
    expect(document.activeElement).toBe(notes);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe(
      "My unsaved title"
    );
  });
  it.each(["new", "cached"])("focuses the immediately available %s task title", async (kind) => {
    if (kind === "cached") client.setQueryData(queryKeys.tasks.detail(task.id), { task });
    await render(kind === "new" ? null : task.id);
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Task title"]'));
  });
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

describe("task detail save boundary", () => {
  it.each(["pointer", "Enter"] as const)(
    "keeps actual task-dialog focus after a %s comment and returns Escape to its opener",
    async (method) => {
      api.addTaskActivity.mockResolvedValue({});
      const opener = document.createElement("button");
      opener.textContent = "Open task";
      document.body.append(opener);
      opener.focus();
      try {
        await render(task.id, () => root.render(null));
        await eventually(() => expect(button("Save changes").disabled).toBe(false));
        const comment = type('textarea[placeholder="Add a comment…"]', "Keep the posted note");
        const post = button("Post comment");
        act(() => {
          if (method === "pointer") {
            post.focus();
            post.click();
          } else {
            comment.focus();
            comment.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
            );
          }
        });
        await eventually(() => expect(comment.value).toBe(""));
        expect(api.addTaskActivity).toHaveBeenCalledOnce();
        const dialog = container.querySelector('[role="dialog"]')!;
        expect(dialog.contains(document.activeElement)).toBe(true);
        act(() =>
          document.activeElement?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
          )
        );
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        await eventually(() => expect(document.activeElement).toBe(opener));
      } finally {
        opener.remove();
      }
    }
  );
  it("asks before discarding main-field edits", async () => {
    const close = vi.fn();
    await render(task.id, close);
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    type('[aria-label="Task title"]', "Unsaved title");
    act(() => button("Cancel").click());
    expect(close).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard unsaved changes?");
    act(() => button("Keep editing").click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Task title"]')?.value).toBe(
      "Unsaved title"
    );
    act(() => button("Cancel").click());
    act(() => button("Discard unsaved changes").click());
    expect(close).toHaveBeenCalledOnce();
    expect(api.updateTask).not.toHaveBeenCalled();
  });
  it("does not reinterpret a saved comment as a transaction to discard", async () => {
    const close = vi.fn();
    api.addTaskActivity.mockResolvedValue({});
    await render(task.id, close);
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    type('textarea[placeholder="Add a comment…"]', "A saved comment");
    act(() => button("Post comment").click());
    await eventually(() =>
      expect(
        container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Add a comment…"]')
          ?.value
      ).toBe("")
    );
    act(() => button("Cancel").click());
    expect(close).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Discard unsaved changes?");
    expect(api.addTaskActivity).toHaveBeenCalledOnce();
  });
  it("routes Escape through the same discard decision without losing the draft", async () => {
    const close = vi.fn();
    await render(task.id, close);
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    const title = type('[aria-label="Task title"]', "Escape must preserve this");
    title.focus();
    act(() => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Discard unsaved changes?");
    expect(title.value).toBe("Escape must preserve this");
  });
  it("discarding after a partly saved new task leaves the saved parts alone", async () => {
    const close = vi.fn();
    api.createTask.mockResolvedValue({ task });
    api.breakdownTask.mockRejectedValue(new Error("Subtask unavailable"));
    await render(null, close);
    type('[aria-label="Task title"]', task.title);
    act(() => container.querySelector<HTMLButtonElement>(".tk-sub__add")!.click());
    type('input[placeholder="Subtask"]', "A child still to save");
    act(() => button("Add task").click());
    await eventually(() => expect(container.textContent).toContain("Could not save"));
    act(() => button("Cancel").click());
    expect(container.textContent).toContain("Discard unsaved changes?");
    act(() => button("Discard unsaved changes").click());
    expect(close).toHaveBeenCalledOnce();
    expect(api.createTask).toHaveBeenCalledOnce();
    expect(api.breakdownTask).toHaveBeenCalledOnce();
    expect(api.updateTask).not.toHaveBeenCalled();
  });
});

it("refreshes list metadata as soon as the implicit first task is created", async () => {
  api.createTask.mockResolvedValue({ task });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await render(null);
  type('[aria-label="Task title"]', task.title);
  act(() => button("Add task").click());
  await eventually(() => expect(api.createTask).toHaveBeenCalledOnce());
  await eventually(() =>
    expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(
      queryKeys.tasks.lists
    )
  );
});

it.each(["comment", "tag", "subtask"] as const)(
  "main save cannot bypass a pending %s write",
  async (kind) => {
    let rejectWrite!: (error: Error) => void;
    const pending = new Promise((_, reject) => {
      rejectWrite = reject;
    });
    const write =
      kind === "comment"
        ? api.addTaskActivity
        : kind === "tag"
          ? api.assignTaskTag
          : api.breakdownTask;
    write.mockReturnValue(pending);
    api.updateTask.mockResolvedValue({ task });
    const close = vi.fn();
    await render(task.id, close);
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    const field = type(
      kind === "comment"
        ? 'textarea[placeholder="Add a comment…"]'
        : kind === "tag"
          ? 'input[aria-label="Add a tag"]'
          : 'input[placeholder="Add a subtask and press Enter"]',
      "Keep pending input"
    );
    if (kind === "comment") act(() => button("Post comment").click());
    else enter(field);
    await eventually(() => expect(button("Cancel").disabled).toBe(true));
    act(() => button("Save changes").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(close).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
    expect(button("Save changes").disabled).toBe(true);
    await act(async () => rejectWrite(new Error("Unavailable")));
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    expect(field.value).toBe("Keep pending input");
    expect(close).not.toHaveBeenCalled();
  }
);

it.each(["none", "due", "reminder"] as const)(
  "delayed locale preserves untouched dates and genuine %s edits",
  async (edited) => {
    const zonedTask = {
      ...task,
      dueAt: "2026-10-11T22:00:00.000Z",
      doAt: "2026-10-11T19:00:00.000Z"
    };
    api.getTask.mockResolvedValue({ task: zonedTask });
    api.updateTask.mockResolvedValue({ task: zonedTask });
    await render();
    await eventually(() => expect(button("Save changes").disabled).toBe(false));
    type('[aria-label="Task title"]', "My title edit stays");
    if (edited === "due") type("#task-due-input", "2026-10-13");
    if (edited === "reminder") type("#task-reminder-input", "2026-10-13");
    await act(async () =>
      client.setQueryData(queryKeys.settings.locale, {
        locale: { timezone: "Pacific/Kiritimati", region: "en-US", dateFormat: "24" }
      })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.querySelector<HTMLInputElement>("#task-due-input")?.value).toBe(
      edited === "due" ? "2026-10-13" : "2026-10-12"
    );
    expect(container.querySelector<HTMLInputElement>("#task-reminder-input")?.value).toBe(
      edited === "reminder" ? "2026-10-13" : "2026-10-12"
    );
    act(() => button("Save changes").click());
    await eventually(() => expect(api.updateTask).toHaveBeenCalledOnce());
    expect(api.updateTask.mock.calls[0]?.[1]).toMatchObject({
      title: "My title edit stays",
      dueAt: edited === "due" ? "2026-10-12T22:00:00.000Z" : zonedTask.dueAt,
      doAt: edited === "reminder" ? "2026-10-12T22:00:00.000Z" : zonedTask.doAt
    });
  }
);
