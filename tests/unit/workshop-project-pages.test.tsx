// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse, WorkshopFeedEntry, WorkshopProject } from "@moss/shared";
import { deriveProjectTitle } from "@moss/shared";
import { WorkshopProjectRoutes } from "../../packages/workshop/src/web/project-routes.js";
import {
  PageTrailProvider,
  resolveTrailSection,
  TopbarMoreActions,
  TopbarTrail,
  usePageTrailValue,
  useRequestPageTrailEdit
} from "../../apps/web/src/shell/page-trail.js";

const project: WorkshopProject = {
  id: "a0000000-0000-4000-8000-000000000001",
  title: "Reading notes",
  initialRequest: "Save the ideas I want to revisit",
  context: "Private to me",
  createdAt: "2026-09-05T12:00:00.000Z",
  updatedAt: "2026-09-05T12:00:00.000Z"
};
// Slice 5: the new-project window names nothing — the service derives the name, so a create
// lands on a fresh id the detail window then loads.
const createdId = "b0000000-0000-4000-8000-000000000002";
let createdBody: Record<string, string> | null;
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
// jsdom ships no Element.scrollTo: stub it on the prototype and record where the thread
// asks to go, so the follow-down behaviour is asserted, not just rendered.
const elementProto = HTMLElement.prototype as HTMLElement & {
  scrollTo?: (options?: ScrollToOptions) => void;
};
let realScrollTo: (options?: ScrollToOptions) => void;
let scrollTops: number[];

function Location() {
  return (
    <>
      <output aria-label="Current location">{useLocation().pathname}</output>
      <Link to={`/workshop/${otherProject.id}`}>Open another project</Link>
    </>
  );
}
// Slice 3: the detail page carries no in-page heading — its title lives in the shell's top-bar
// trail, so this probe stands in for the top bar and asserts what the page published there.
function TrailName() {
  const trail = usePageTrailValue();
  return <output aria-label="Page trail">{trail?.name ?? ""}</output>;
}
// The shell's real top-bar title and More menu, wired the way app-shell wires them: the page
// publishes the trail, the shell prepends its own Rename item whenever the page allows
// renaming, and choosing it turns the title itself into the field. The item id must match
// the shell's RENAME_TRAIL_ACTION; if it drifts, choosing Rename opens no editor and the
// rename test below fails on the missing field.
function RealTrail() {
  const trail = usePageTrailValue();
  const location = useLocation();
  const requestEdit = useRequestPageTrailEdit();
  if (!trail) return null;
  const section = resolveTrailSection(location.pathname);
  const actions = trail.onRename
    ? [{ id: "__trail_rename", label: "Rename" }, ...trail.actions]
    : trail.actions;
  return (
    <>
      <TopbarTrail
        sectionLabel={section.label}
        sectionPath={section.path}
        name={trail.name}
        meta={trail.meta}
        onRename={trail.onRename}
      />
      <TopbarMoreActions
        actions={actions}
        onAction={(id) => {
          if (id === "__trail_rename") requestEdit();
          else trail.onAction?.(id);
        }}
      />
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
          <PageTrailProvider>
            <Location />
            <TrailName />
            <RealTrail />
            <Routes>
              <Route path="/workshop/*" element={<WorkshopProjectRoutes />} />
            </Routes>
          </PageTrailProvider>
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
function typeName(value: string) {
  const element = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]');
  if (!element) throw new Error("Missing project name field");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) {
  // Most buttons carry their words as text; icon-only buttons (the arrow send button)
  // carry no words, so match their accessible name instead. Never match an accessible
  // name on a button that already has words — the words are what a person sees.
  const element = [...container.querySelectorAll("button")].find((item) => {
    if (item.textContent === label) return true;
    return (item.textContent ?? "").trim() === "" && item.getAttribute("aria-label") === label;
  });
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
  createdBody = null;
  scrollTops = [];
  realScrollTo = elementProto.scrollTo?.bind(elementProto) ?? (() => {});
  elementProto.scrollTo = function (options?: ScrollToOptions) {
    scrollTops.push(options?.top ?? 0);
  };
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
          createdBody = body;
          return response(
            {
              project: {
                ...project,
                id: createdId,
                title: body.title ?? deriveProjectTitle(body.initialRequest!),
                initialRequest: body.initialRequest
              },
              created: true,
              destination: `/workshop/${createdId}`
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
      if (init?.method === "PATCH" && path === `${base}/${project.id}`) {
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        writes.push({ path, body });
        return response({ project: { ...project, title: body.title! } });
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
      if (path === `${base}/${createdId}` && createdBody)
        return response({
          project: {
            ...project,
            id: createdId,
            title: deriveProjectTitle(createdBody.initialRequest!),
            initialRequest: createdBody.initialRequest
          }
        });
      if (path.startsWith(`${base}/${createdId}/messages?`))
        return response({ entries: [], nextCursor: "0" });
      throw new Error(`Unexpected request: ${path}`);
    })
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  elementProto.scrollTo = realScrollTo;
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

describe("Workshop project browser interactions", () => {
  it("shows the invitation with examples that fill the box without sending", async () => {
    await render("/workshop/new");
    await eventually(() => expect(container.textContent).toContain("What would you like to make?"));
    expect(container.querySelector('[aria-label="Page trail"]')?.textContent).toBe("New project");
    click("Track the books I read");
    expect(field("project-message").value).toBe("Track the books I read");
    expect(writes).toHaveLength(0);
    expect(container.querySelector("output")?.textContent).toBe("/workshop/new");
  });

  it("creates with no title on send, replaces the URL, and retries the same key after failure", async () => {
    createFailures = 1;
    await render("/workshop/new");
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "Keep a private list of book ideas.");
    click("Send");
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be confirmed as saved"
      )
    );
    expect(field("project-message").value).toBe("Keep a private list of book ideas.");
    click("Send");
    await eventually(() =>
      expect(container.querySelector("output")?.textContent).toBe(`/workshop/${createdId}`)
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(writes[0]!.body.requestKey).toMatch(/^[0-9a-f-]{36}$/i);
    // No name travels up front; the service derives it from the request's first line.
    expect("title" in writes[0]!.body).toBe(false);
    const derived = deriveProjectTitle("Keep a private list of book ideas.");
    await eventually(() =>
      expect(container.querySelector('[aria-label="Page trail"]')?.textContent).toBe(derived)
    );
    // The request opens the window as its first turn.
    expect(container.querySelector(".chatd-thread")?.textContent).toContain(
      "Keep a private list of book ideas."
    );
  });

  it("uses a new request key when a failed create's payload is edited", async () => {
    createFailures = 2;
    await render("/workshop/new");
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "Keep a private list of book ideas.");
    click("Send");
    await eventually(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    type("project-message", "Changed requirements");
    click("Send");
    await eventually(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body.requestKey).not.toBe(writes[0]!.body.requestKey);
    expect(writes[1]!.body.initialRequest).toBe("Changed requirements");
  });

  it("keeps unsent text across failed sends, retries the same message, and shows pending saved state", async () => {
    messageFailures = 1;
    await render(`/workshop/${project.id}`);
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "Keep this additional requirement");
    // The window is the chat alone: the opening request is the first turn, with no pane switch.
    expect(container.querySelector(".chatd-thread")?.textContent).toContain(project.initialRequest);
    await eventually(() => expect(button("Send").disabled).toBe(false));
    click("Send");
    await eventually(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("same message")
    );
    expect(field("project-message").value).toBe("Keep this additional requirement");
    click("Send");
    // The retry saves: the turn renders in the thread at once, no status line narrates it.
    await eventually(() =>
      expect(container.querySelector(".chatd-thread")?.textContent).toContain(
        "Keep this additional requirement"
      )
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
    expect(field("project-message").value).toBe("");
    // Ben's ruling on 2404: no status line narrating that saving started no planning or build.
    expect(container.textContent).not.toContain("No planning or build has started");
  });

  it("sends the project message on Enter, but not on Shift+Enter", async () => {
    await render(`/workshop/${project.id}`);
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "A line, then a break");
    await eventually(() => expect(button("Send").disabled).toBe(false));
    act(() => {
      field("project-message").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      );
    });
    expect(writes).toHaveLength(0);
    const scrollsBefore = scrollTops.length;
    act(() => {
      field("project-message").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    });
    await eventually(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.text).toBe("A line, then a break");
    expect(field("project-message").value).toBe("");
    // The fresh turn follows the thread down while the reader is at the bottom.
    await eventually(() => expect(scrollTops.length).toBeGreaterThan(scrollsBefore));
  });

  it("renames through the More menu, typing the name one letter at a time", async () => {
    await render(`/workshop/${project.id}`);
    await eventually(() =>
      expect(container.querySelector('[aria-label="Page trail"]')?.textContent).toBe(project.title)
    );
    click("More");
    click("Rename");
    await eventually(() =>
      expect(container.querySelector('input[aria-label="Project name"]')).not.toBeNull()
    );
    // One letter at a time with renders flushed between keystrokes: the old field
    // re-selected its whole content on every render, so only the last letter survived.
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");
    const target = "Reading list";
    let current = "";
    for (const letter of target) {
      current += letter;
      typeName(current);
      await flush();
    }
    const reselects = selectSpy.mock.calls.length;
    selectSpy.mockRestore();
    // Focusing the fresh field selects once; no keystroke may reselect.
    expect(reselects).toBe(0);
    await act(async () => {
      container
        .querySelector<HTMLFormElement>('form[aria-label="Rename this project"]')!
        .requestSubmit();
    });
    await eventually(() =>
      expect(
        writes.some(
          (write) => write.path === `${base}/${project.id}` && write.body.title === target
        )
      ).toBe(true)
    );
    expect(container.querySelector('[aria-label="Page trail"]')?.textContent).toBe(target);
  });

  it("retains the composer and blocks saves until reconnect refresh succeeds", async () => {
    await render(`/workshop/${project.id}`);
    await eventually(() => expect(container.querySelector("#project-message")).not.toBeNull());
    type("project-message", "Unsent while offline");
    await eventually(() => expect(button("Send").disabled).toBe(false));
    act(() => onlineManager.setOnline(false));
    expect(button("Send").disabled).toBe(true);
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
    expect(button("Send").disabled).toBe(true);
    expect(field("project-message").value).toBe("Unsent while offline");
    click("Send");
    expect(writes).toEqual([]);

    await act(async () => resolveRefresh(response({ error: "Refresh failed" }, 503)));
    await eventually(() =>
      expect(container.textContent).toContain("Your saved work could not be refreshed")
    );
    expect(button("Send").disabled).toBe(true);
    expect(field("project-message").value).toBe("Unsent while offline");

    refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    click("Reconnect");
    expect(button("Send").disabled).toBe(true);
    await act(async () => resolveRefresh(response({ project })));
    await eventually(() => expect(button("Send").disabled).toBe(false));
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
      expect(container.querySelector('[aria-label="Page trail"]')?.textContent).toBe(
        otherProject.title
      )
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
