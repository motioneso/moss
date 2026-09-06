// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse, WorkshopFeedEntry, WorkshopProject } from "@moss/shared";
import { WorkshopProjectRoutes } from "../../packages/workshop/src/web/project-routes.js";

const project: WorkshopProject = {
  id: "a0000000-0000-4000-8000-000000000001",
  title: "Reading notes",
  initialRequest: "Save the ideas I want to revisit",
  context: "Private to me",
  createdAt: "2026-09-05T12:00:00.000Z",
  updatedAt: "2026-09-05T12:00:00.000Z"
};
const otherProject = {
  ...project,
  id: "a0000000-0000-4000-8000-000000000003",
  title: "Other project"
};
const me: MeResponse = {
  user: {
    id: "a0000000-0000-4000-8000-000000000002",
    email: "owner@example.invalid",
    emailVerified: true,
    name: "Owner",
    isInstanceAdmin: true,
    status: "active",
    isBootstrapOwner: true,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};
const base = "/api/workshop/projects";
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let createFailures: number;
let messageFailures: number;
let listStatus: number;
let detailStatus: number;
let admin: boolean;
let entries: WorkshopFeedEntry[];
let writes: { path: string; body: Record<string, string> }[];
let reads: string[];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function Location() {
  return (
    <>
      <output aria-label="Current location">{useLocation().pathname}</output>
      <Link to={`/workshop/${otherProject.id}`}>Open another project</Link>
    </>
  );
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function eventually(check: () => void) {
  await vi.waitFor(
    async () => {
      await flush();
      check();
    },
    { timeout: 1500 }
  );
}
async function render(path: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Location />
          <Routes>
            <Route path="/workshop/*" element={<WorkshopProjectRoutes />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  await eventually(() => expect(container.textContent).not.toContain("Loading Workshop…"));
}
function field(id: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (!element) throw new Error(`Missing field ${id}`);
  return element;
}
function type(id: string, value: string) {
  const element = field(id);
  // Use the native setter so React's value tracker observes an actual DOM input change.
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label
  );
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}
function click(label: string) {
  act(() => button(label).click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onlineManager.setOnline(true);
  createFailures = 0;
  messageFailures = 0;
  listStatus = 200;
  detailStatus = 200;
  admin = true;
  entries = [];
  writes = [];
  reads = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        writes.push({ path, body });
        if (path === base) {
          if (createFailures-- > 0) return response({ error: "Temporary failure" }, 503);
          return response(
            {
              project: { ...project, title: body.title, initialRequest: body.initialRequest },
              created: true,
              destination: `/workshop/${project.id}`
            },
            201
          );
        }
        if (path === `${base}/${project.id}/messages`) {
          if (messageFailures-- > 0) return response({ error: "Temporary failure" }, 503);
          const entry: WorkshopFeedEntry = {
            projectId: project.id,
            messageId: body.messageId!,
            text: body.text!,
            sequence: "1",
            kind: "user_message",
            delivery: "pending",
            createdAt: project.createdAt
          };
          entries = [entry];
          return response({ entry, created: true }, 201);
        }
      }
      reads.push(path);
      if (path === "/api/me")
        return response({ ...me, user: { ...me.user, isInstanceAdmin: admin } });
      if (path.startsWith(`${base}?`))
        return response(
          listStatus === 200 ? { projects: [], nextCursor: null } : { error: "Temporary failure" },
          listStatus
        );
      if (path === `${base}/${project.id}`)
        return response(detailStatus === 200 ? { project } : { error: "Not found" }, detailStatus);
      if (path.startsWith(`${base}/${project.id}/messages?`))
        return response({ entries, nextCursor: entries.at(-1)?.sequence ?? "0" });
      throw new Error(`Unexpected request: ${path}`);
    })
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

describe("Workshop project browser interactions", () => {
  it("retains create text and request key after failure, then opens the saved destination on retry", async () => {
    createFailures = 1;
    await render("/workshop/new");
    type("project-title", project.title);
    type("project-idea", project.initialRequest);
    type("project-context", project.context);
    click("Create project");
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be confirmed as saved"
      )
    );
    expect(field("project-title").value).toBe(project.title);
    expect(field("project-idea").value).toBe(project.initialRequest);
    expect(field("project-context").value).toBe(project.context);
    click("Create project");
    await eventually(() =>
      expect(container.querySelector("output")?.textContent).toBe(`/workshop/${project.id}`)
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(writes[0]!.body.requestKey).toMatch(/^[0-9a-f-]{36}$/i);
    await eventually(() => expect(container.textContent).toContain(project.title));
    expect(container.textContent).toContain("No plan yet");
  });

  it("uses a new request key when a failed create's payload is edited", async () => {
    createFailures = 2;
    await render("/workshop/new");
    type("project-title", project.title);
    type("project-idea", project.initialRequest);
    click("Create project");
    await eventually(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    type("project-idea", "Changed requirements");
    click("Create project");
    await eventually(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body.requestKey).not.toBe(writes[0]!.body.requestKey);
    expect(writes[1]!.body.initialRequest).toBe("Changed requirements");
  });

  it("keeps unsent text across mobile panes and failed sends, retries the same message, and shows pending saved state", async () => {
    messageFailures = 1;
    await render(`/workshop/${project.id}`);
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "Keep this additional requirement");
    click("Project work");
    expect(button("Project work").getAttribute("aria-pressed")).toBe("true");
    expect(field("project-message").value).toBe("Keep this additional requirement");
    click("Conversation");
    expect(button("Conversation").getAttribute("aria-pressed")).toBe("true");
    expect(field("project-message").value).toBe("Keep this additional requirement");
    await eventually(() => expect(button("Save message").disabled).toBe(false));
    click("Save message");
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("same message")
    );
    expect(field("project-message").value).toBe("Keep this additional requirement");
    click("Save message");
    await eventually(() => expect(container.textContent).toContain("Saved · awaiting delivery"));
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(field("project-message").value).toBe("");
    expect(container.textContent).toContain(
      "Saved to this project. No planning or build has started."
    );
  });

  it("retains the composer and blocks saves until reconnect refresh succeeds", async () => {
    await render(`/workshop/${project.id}`);
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "Unsent while offline");
    await eventually(() => expect(button("Save message").disabled).toBe(false));
    act(() => onlineManager.setOnline(false));
    expect(button("Save message").disabled).toBe(true);
    expect(field("project-message").value).toBe("Unsent while offline");

    let resolveRefresh!: (value: Response) => void;
    let refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const previousFetch = fetch;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === `${base}/${project.id}` ? refresh : previousFetch(input, init)
    );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => onlineManager.setOnline(true));
    await eventually(() =>
      expect(fetchMock.mock.calls.some(([path]) => String(path) === `${base}/${project.id}`)).toBe(
        true
      )
    );
    expect(container.textContent).toContain("Refreshing your saved work");
    expect(button("Save message").disabled).toBe(true);
    expect(field("project-message").value).toBe("Unsent while offline");
    click("Save message");
    expect(writes).toEqual([]);

    await act(async () => resolveRefresh(response({ error: "Refresh failed" }, 503)));
    await eventually(() =>
      expect(container.textContent).toContain("Your saved work could not be refreshed")
    );
    expect(button("Save message").disabled).toBe(true);
    expect(field("project-message").value).toBe("Unsent while offline");

    refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    click("Reconnect");
    expect(button("Save message").disabled).toBe(true);
    await act(async () => resolveRefresh(response({ project })));
    await eventually(() => expect(button("Save message").disabled).toBe(false));
    expect(field("project-message").value).toBe("Unsent while offline");
    expect(writes).toEqual([]);
  });

  it("does not carry a draft from one project into a different project route", async () => {
    const previousFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === `${base}/${otherProject.id}`)
          return Promise.resolve(response({ project: otherProject }));
        if (path.startsWith(`${base}/${otherProject.id}/messages?`))
          return Promise.resolve(response({ entries: [], nextCursor: "0" }));
        return previousFetch(input, init);
      })
    );
    await render(`/workshop/${project.id}`);
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "This belongs only to the first project");
    act(() =>
      container.querySelector<HTMLAnchorElement>(`a[href="/workshop/${otherProject.id}"]`)!.click()
    );
    await eventually(() =>
      expect(container.querySelector("h1")?.textContent).toBe(otherProject.title)
    );
    expect(field("project-message").value).toBe("");
  });

  it("shows a failed project query as an error and lets the user retry", async () => {
    listStatus = 503;
    await render("/workshop");
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be loaded"
      )
    );
    expect(container.textContent).not.toContain("A small idea is a good start.");
    listStatus = 200;
    click("Try again");
    await eventually(() =>
      expect(container.textContent).toContain("A small idea is a good start.")
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("denies non-admin entry before fetching or displaying private project controls", async () => {
    admin = false;
    await render(`/workshop/${project.id}`);
    expect(container.textContent).toContain("The Workshop is for instance admins");
    expect(container.querySelector("form")).toBeNull();
    expect(reads).toEqual(["/api/me"]);
    expect(writes).toEqual([]);
  });

  it("shows an unavailable owned-project response without a composer", async () => {
    detailStatus = 404;
    await render(`/workshop/${project.id}`);
    await eventually(() =>
      expect(container.textContent).toContain("This project is not available to you.")
    );
    expect(container.querySelector("#project-message")).toBeNull();
  });
});
