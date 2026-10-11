// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "@moss/shared";
import { BriefTaskRow } from "../../apps/web/src/today/brief-task-row.js";
import { TaskRow } from "../../apps/web/src/tasks/task-list-view.js";
import type * as LocaleFormat from "../../apps/web/src/locale/locale-format.js";

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({ useAssistantName: () => "Moss" }));
vi.mock("../../apps/web/src/locale/locale-format.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LocaleFormat>()),
  useUserLocale: () => ({ timezone: "UTC", region: "en-US", dateFormat: "24" })
}));
const task: TaskDto = {
  id: "task-status",
  ownerUserId: "owner",
  listId: "personal",
  parentTaskId: null,
  title: "Confirm the result",
  description: null,
  status: "todo",
  priority: null,
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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
async function render(
  kind: "today" | "tasks",
  current: TaskDto,
  save: (status: "todo" | "done") => Promise<unknown>
) {
  await act(async () =>
    root.render(
      kind === "today" ? (
        <BriefTaskRow task={current} onOpen={() => undefined} onToggle={save} />
      ) : (
        <TaskRow
          task={current}
          isUpdating={false}
          onOpen={() => undefined}
          onToggleDone={(current) => save(current.status === "done" ? "todo" : "done")}
        />
      )
    )
  );
}

describe("mounted task completion", () => {
  it.each(["today", "tasks"] as const)(
    "%s follows status changed through task details or a refresh",
    async (kind) => {
      const save = vi.fn(async () => undefined);
      await render(kind, task, save);
      expect(checkbox().checked).toBe(false);
      await render(kind, { ...task, status: "done" }, save);
      expect(checkbox().checked).toBe(true);
      await render(kind, task, save);
      expect(checkbox().checked).toBe(false);
      expect(save).not.toHaveBeenCalled();
    }
  );
  it("Today rolls a failed completion back and allows a retry", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue(undefined);
    await render("today", task, save);
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    expect(container.textContent).toContain("Could not update this task");
    await act(async () => checkbox().click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(checkbox().checked).toBe(true);
    expect(container.textContent).not.toContain("Could not update this task");
  });
  it("Today blocks repeated completion while the write is pending", async () => {
    let resolve!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    await render("today", task, save);
    act(() => checkbox().click());
    expect(checkbox().disabled).toBe(true);
    act(() => checkbox().click());
    expect(save).toHaveBeenCalledOnce();
    await act(async () => resolve());
    expect(checkbox().disabled).toBe(false);
  });
});

it.each(["today", "tasks"] as const)(
  "%s immediate reopen sends the requested status before refresh",
  async (kind) => {
    const writes: string[] = [];
    const save = vi.fn(async (status: string) => {
      writes.push(status);
    });
    await render(kind, task, save);
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(true);
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    expect(writes).toEqual(["done", "todo"]);
  }
);

it.each(["today", "tasks"] as const)(
  "%s failed reopen restores the last successful write before refresh",
  async (kind) => {
    const save = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Unavailable"));
    await render(kind, task, save);
    await act(async () => checkbox().click());
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(true);
    expect(save.mock.calls.map(([status]) => status)).toEqual(["done", "todo"]);
  }
);

it("review: Tasks failed toggle retains the latest refreshed server status", async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      })
  );
  await render("tasks", task, save);
  act(() => checkbox().click());
  await render("tasks", { ...task, status: "done" }, save);
  expect(checkbox().checked).toBe(true);
  await act(async () => reject(new Error("Unavailable")));
  expect(checkbox().checked).toBe(true);
});

it.each(["today", "tasks"] as const)(
  "%s late success cannot replace a newer authoritative rollback baseline",
  async (kind) => {
    let resolve!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          })
      )
      .mockRejectedValueOnce(new Error("Unavailable"));
    await render(kind, task, save);
    act(() => checkbox().click());
    await render(kind, { ...task, status: "done" }, save);
    await render(kind, task, save);
    expect(checkbox().checked).toBe(false);
    await act(async () => resolve());
    expect(checkbox().checked).toBe(false);
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    expect(save.mock.calls.map(([status]) => status)).toEqual(["done", "done"]);
  }
);

it.each(["today", "tasks"] as const)(
  "%s newer same-status server version supersedes a pending optimistic completion",
  async (kind) => {
    let resolve!: () => void;
    const initial = { ...task, updatedAt: "2026-10-11T00:00:00.000Z" };
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          })
      )
      .mockRejectedValueOnce(new Error("Unavailable"));
    await render(kind, initial, save);
    act(() => checkbox().click());
    expect(checkbox().checked).toBe(true);
    await render(kind, { ...initial, updatedAt: "2026-10-11T00:01:00.000Z" }, save);
    expect(checkbox().checked).toBe(false);
    await act(async () => resolve());
    expect(checkbox().checked).toBe(false);
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    expect(save.mock.calls.map(([status]) => status)).toEqual(["done", "done"]);
  }
);

it.each(["today", "tasks"] as const)(
  "%s unchanged server version does not erase a successful write before refresh",
  async (kind) => {
    const initial = { ...task, updatedAt: "2026-10-11T00:00:00.000Z" };
    const save = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Unavailable"));
    await render(kind, initial, save);
    await act(async () => checkbox().click());
    await render(kind, { ...initial }, save);
    expect(checkbox().checked).toBe(true);
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(true);
    expect(save.mock.calls.map(([status]) => status)).toEqual(["done", "todo"]);
  }
);
