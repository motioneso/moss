// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TaskCapture } from "../../apps/web/src/tasks/task-capture.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";

const api = vi.hoisted(() => ({ createTask: vi.fn() }));
vi.mock("../../apps/web/src/api/client.js", () => api);

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let lists: readonly { readonly id: string; readonly name: string }[];
const readLists = vi.fn(async () => ({ lists }));

function ListMetadata() {
  const result = useQuery({ queryKey: queryKeys.tasks.lists, queryFn: readLists });
  return (
    <output aria-label="Saved task lists">
      {result.data?.lists.map((list) => list.name).join(", ")}
    </output>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.createTask.mockReset();
  readLists.mockClear();
  lists = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15_000 }, mutations: { retry: false } }
  });
  client.setQueryData(queryKeys.tasks.lists, { lists: [] });
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

async function mount() {
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <ListMetadata />
          <TaskCapture onDetails={() => undefined} />
        </QueryClientProvider>
      </StrictMode>
    )
  );
}

function submit() {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "First task"
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() =>
    container.querySelector<HTMLFormElement>('form[aria-label="Capture a task"]')!.requestSubmit()
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

it("refreshes a fresh empty list index when quick capture implicitly creates Personal", async () => {
  api.createTask.mockImplementation(async () => {
    lists = [{ id: "personal", name: "Personal" }];
    return { task: { id: "first-task" } };
  });
  await mount();
  expect(readLists).not.toHaveBeenCalled();
  submit();
  await eventually(() =>
    expect(api.createTask).toHaveBeenCalledWith({ title: "First task", listId: undefined })
  );
  await eventually(() => expect(container.querySelector("output")?.textContent).toBe("Personal"));
  expect(readLists).toHaveBeenCalledOnce();
});

it("retains a failed quick-capture title without inventing or refreshing list metadata", async () => {
  api.createTask.mockRejectedValue(new Error("Try later"));
  await mount();
  submit();
  await eventually(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try later")
  );
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')?.value).toBe(
    "First task"
  );
  expect(readLists).not.toHaveBeenCalled();
  expect(container.querySelector("output")?.textContent).toBe("");
});
