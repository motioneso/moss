// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../apps/web/src/api/client.js";
import type * as apiClient from "../../apps/web/src/api/client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { SourcesPane } from "../../apps/web/src/settings/settings-personal-data-panes.js";
import { DataExport } from "../../apps/web/src/settings/settings-profile-subviews.js";

const mocks = vi.hoisted(() => ({
  getNotesSource: vi.fn(),
  putNotesSource: vi.fn(),
  getNotesLastSync: vi.fn(),
  getNotesSourceDirectories: vi.fn(),
  postNotesSync: vi.fn(),
  getDataExportStatus: vi.fn(),
  startDataExport: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn()
}));
vi.mock("../../apps/web/src/api/notes-client.js", () => ({
  getNotesSource: mocks.getNotesSource,
  putNotesSource: mocks.putNotesSource,
  getNotesLastSync: mocks.getNotesLastSync,
  getNotesSourceDirectories: mocks.getNotesSourceDirectories,
  postNotesSync: mocks.postNotesSync
}));
vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof apiClient>()),
  getDataExportStatus: mocks.getDataExportStatus,
  startDataExport: mocks.startDataExport
}));
vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss",
  personalize: (text: string) => text
}));
vi.mock("../../apps/web/src/settings/settings-feedback.js", () => ({
  useFeedback: () => ({ toast: mocks.toast, confirm: mocks.confirm })
}));
vi.mock("../../apps/web/src/shell/chat-controls-context.js", () => ({
  useChatControls: () => ({ pendingNotesDelete: null, openActionRequest: undefined })
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const storageKey = "moss.settings.export-job-id";
const jobId = "11111111-1111-4111-8111-111111111111";
const renderers: ReactTestRenderer[] = [];
const clients: QueryClient[] = [];

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}
function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.find((node) => node.type === "button" && textOf(node) === label);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render(surface: "sources" | "export", client?: QueryClient) {
  const queryClient = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        {surface === "sources" ? <SourcesPane embedded /> : <DataExport />}
      </QueryClientProvider>
    );
  });
  renderers.push(renderer);
  await settle();
  return renderer;
}
async function click(renderer: ReactTestRenderer, label: string) {
  await act(async () => {
    button(renderer, label).props.onClick();
  });
  await settle();
}
async function confirmUnlink(renderer: ReactTestRenderer) {
  await click(renderer, "Unlink");
  await act(async () => {
    mocks.confirm.mock.lastCall![0].onConfirm();
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.getNotesSource.mockResolvedValue({ path: "/synthetic/notes" });
  mocks.getNotesLastSync.mockResolvedValue({ lastSync: null });
  mocks.getNotesSourceDirectories.mockResolvedValue({
    path: "/synthetic/notes",
    directories: [{ name: "Synthetic notes", path: "/synthetic/notes" }]
  });
  mocks.putNotesSource.mockResolvedValue({ path: null });
  mocks.getDataExportStatus.mockResolvedValue({ jobId, status: "ready" });
  mocks.startDataExport.mockResolvedValue({ jobId, status: "pending" });
});
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

describe("CORE01 Notes source outcome truth", () => {
  it("keeps a cold loading source unknown and prevents an edit", async () => {
    mocks.getNotesSource.mockReturnValue(deferred<{ path: string | null }>().promise);
    const renderer = await render("sources");
    expect(textOf(renderer.root)).toContain("Checking linked folder");
    expect(textOf(renderer.root)).not.toContain("No folder linked");
    expect(button(renderer, "Browse…").props.disabled).toBe(true);
  });

  it("offers retry after a failed cold read and only then reports an unlinked folder", async () => {
    mocks.getNotesSource.mockRejectedValueOnce(new Error("offline"));
    const renderer = await render("sources");
    expect(textOf(renderer.root)).toContain("Couldn't check linked folder");
    expect(textOf(renderer.root)).not.toContain("No folder linked");
    expect(button(renderer, "Browse…").props.disabled).toBe(true);
    mocks.getNotesSource.mockResolvedValueOnce({ path: null });
    await click(renderer, "Try again");
    expect(textOf(renderer.root)).toContain("No folder linked");
    expect(button(renderer, "Browse…").props.disabled).toBe(false);
    expect(mocks.putNotesSource).not.toHaveBeenCalled();
  });

  it("announces unlink only after persistence and disables all source changes while pending", async () => {
    const write = deferred<{ path: null }>();
    mocks.putNotesSource.mockReturnValue(write.promise);
    const renderer = await render("sources");
    await confirmUnlink(renderer);
    expect(mocks.putNotesSource).toHaveBeenCalledExactlyOnceWith({ path: null });
    expect(mocks.toast).not.toHaveBeenCalledWith("Folder unlinked", expect.anything());
    expect(textOf(renderer.root)).toContain("/synthetic/notes");
    expect(button(renderer, "Unlinking…").props.disabled).toBe(true);
    expect(button(renderer, "Sync now").props.disabled).toBe(true);
    await act(async () => write.resolve({ path: null }));
    await settle();
    expect(textOf(renderer.root)).toContain("No folder linked");
    expect(mocks.toast).toHaveBeenCalledWith("Folder unlinked", expect.anything());
  });

  it("keeps the linked folder after a rejected unlink and never announces success", async () => {
    const write = deferred<{ path: null }>();
    mocks.putNotesSource.mockReturnValue(write.promise);
    const renderer = await render("sources");
    await confirmUnlink(renderer);
    await act(async () => write.reject(new Error("Couldn't save source")));
    await settle();
    expect(textOf(renderer.root)).toContain("/synthetic/notes");
    expect(button(renderer, "Unlink").props.disabled).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalledWith("Folder unlinked", expect.anything());
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't save source", expect.anything());
  });

  it("prevents repeated chooser writes while a source save is pending", async () => {
    const write = deferred<{ path: string }>();
    mocks.putNotesSource.mockReturnValue(write.promise);
    const renderer = await render("sources");
    await click(renderer, "Change folder");
    const submit = button(renderer, "Use this folder");
    // Two queued events can arrive before React commits the pending render.
    await act(async () => {
      submit.props.onClick();
      submit.props.onClick();
    });
    await settle();
    expect(mocks.putNotesSource).toHaveBeenCalledTimes(1);
    expect(button(renderer, "Use this folder").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Linking folder");
    expect(mocks.toast).not.toHaveBeenCalled();
    await act(async () => write.resolve({ path: "/synthetic/notes" }));
    await settle();
    expect(textOf(renderer.root)).toContain("/synthetic/notes");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("blocks a chooser opened before a failed source refresh and recovers after Cancel", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = await render("sources", client);
    await click(renderer, "Change folder");
    mocks.getNotesSource.mockRejectedValueOnce(new Error("Synthetic outage"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.settings.notesSource });
    });
    await settle();
    expect(button(renderer, "Use this folder").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Cancel to retry before saving a folder");
    await click(renderer, "Use this folder");
    expect(mocks.putNotesSource).not.toHaveBeenCalled();
    await click(renderer, "Cancel");
    expect(textOf(renderer.root)).toContain("Couldn't check linked folder");
    await click(renderer, "Try again");
    expect(button(renderer, "Change folder").props.disabled).toBe(false);
  });

  it("rechecks source authority when an already-open unlink confirmation submits", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = await render("sources", client);
    await click(renderer, "Unlink");
    mocks.getNotesSource.mockRejectedValueOnce(new Error("Synthetic outage"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.settings.notesSource });
    });
    await settle();
    await act(async () => mocks.confirm.mock.lastCall![0].onConfirm());
    await settle();
    expect(mocks.putNotesSource).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith("Folder unlinked", expect.anything());
    expect(textOf(renderer.root)).toContain("Couldn't check linked folder");
  });

  it("keeps a persisted unlink authoritative when an older in-flight GET later resolves", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const write = deferred<{ path: null }>();
    const olderRead = deferred<{ path: string }>();
    mocks.putNotesSource.mockReturnValue(write.promise);
    const renderer = await render("sources", client);
    await confirmUnlink(renderer);
    mocks.getNotesSource.mockReturnValueOnce(olderRead.promise);
    await act(async () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings.notesSource });
    });
    await settle();
    expect(mocks.getNotesSource).toHaveBeenCalledTimes(2);
    await act(async () => write.resolve({ path: null }));
    await settle();
    expect(textOf(renderer.root)).toContain("No folder linked");
    await act(async () => olderRead.resolve({ path: "/synthetic/notes" }));
    await settle();
    expect(client.getQueryData(queryKeys.settings.notesSource)).toEqual({ path: null });
    expect(textOf(renderer.root)).toContain("No folder linked");
    expect(
      renderer.root.findAll((node) => node.type === "button" && textOf(node) === "Sync now")
    ).toHaveLength(0);
  });

  it("retains shared pending unlink authority across pane navigation and settles the original write", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const write = deferred<{ path: null }>();
    mocks.putNotesSource.mockReturnValue(write.promise);
    const first = await render("sources", client);
    await confirmUnlink(first);
    await act(async () => first.unmount());
    const second = await render("sources", client);
    expect(button(second, "Unlinking…").props.disabled).toBe(true);
    expect(button(second, "Change folder").props.disabled).toBe(true);
    expect(button(second, "Sync now").props.disabled).toBe(true);
    // Even stale callbacks queued by a departing pane cannot create another write.
    await act(async () => mocks.confirm.mock.lastCall![0].onConfirm());
    await settle();
    expect(mocks.putNotesSource).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve({ path: null }));
    await settle();
    expect(textOf(second.root)).toContain("No folder linked");
    expect(button(second, "Browse…").props.disabled).toBe(false);
  });

  it("releases shared pending authority after a rejected unlink across navigation", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const write = deferred<{ path: null }>();
    mocks.putNotesSource.mockReturnValue(write.promise);
    const first = await render("sources", client);
    await confirmUnlink(first);
    await act(async () => first.unmount());
    const second = await render("sources", client);
    expect(button(second, "Unlinking…").props.disabled).toBe(true);
    await act(async () => write.reject(new Error("Synthetic save failure")));
    await settle();
    expect(textOf(second.root)).toContain("/synthetic/notes");
    expect(button(second, "Unlink").props.disabled).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalledWith("Folder unlinked", expect.anything());
    mocks.putNotesSource.mockResolvedValue({ path: null });
    await confirmUnlink(second);
    expect(mocks.putNotesSource).toHaveBeenCalledTimes(2);
    expect(textOf(second.root)).toContain("No folder linked");
  });

  it("retains the last known folder but blocks changes after a failed refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.notesSource, { path: "/synthetic/previous" });
    mocks.getNotesSource.mockRejectedValue(new Error("offline"));
    const renderer = await render("sources", client);
    expect(textOf(renderer.root)).toContain("/synthetic/previous");
    expect(textOf(renderer.root)).toContain("Couldn't check linked folder");
    expect(button(renderer, "Change folder").props.disabled).toBe(true);
    expect(button(renderer, "Unlink").props.disabled).toBe(true);
  });
});

describe("CORE01/03 outage remount with the real app cache policy", () => {
  it("keeps the real UAT outage waits longer than the app's actual query freshness", () => {
    const app = readFileSync("apps/web/src/main.tsx", "utf8");
    const uat = readFileSync("tests/uat/specs/audit-source-truth.uat.spec.ts", "utf8");
    const freshnessMatch = app.match(/staleTime:\s*([\d_]+)/);
    expect(freshnessMatch).not.toBeNull();
    const freshness = Number(freshnessMatch![1]!.replaceAll("_", ""));
    const waits = [...uat.matchAll(/await page\.waitForTimeout\(([\d_]+)\)/g)].map((match) =>
      Number(match[1]!.replaceAll("_", ""))
    );
    expect(waits).toHaveLength(2);
    expect(waits.every((wait) => wait > freshness)).toBe(true);
    expect(uat.match(/page\.waitForRequest\(/g)).toHaveLength(2);
  });

  it.each(["sources", "export"] as const)(
    "requires freshness expiry before %s issues its outage GET",
    async (surface) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false }
        }
      });
      if (surface === "export") window.sessionStorage.setItem(storageKey, jobId);
      const read = surface === "sources" ? mocks.getNotesSource : mocks.getDataExportStatus;
      const first = await render(surface, client);
      await act(async () => first.unmount());
      read.mockRejectedValue(new ApiError(503, "Synthetic service outage"));
      const freshRemount = await render(surface, client);
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () => freshRemount.unmount());
      clock.mockReturnValue(now + 16_000);
      const staleRemount = await render(surface, client);
      expect(read).toHaveBeenCalledTimes(2);
      expect(textOf(staleRemount.root)).toContain(
        surface === "sources" ? "Couldn't check linked folder" : "Couldn't check your export"
      );
    }
  );
});

describe("CORE03 restored account export recovery", () => {
  it("shows status checking while a restored job has no status yet", async () => {
    window.sessionStorage.setItem(storageKey, jobId);
    mocks.getDataExportStatus.mockReturnValue(deferred().promise);
    const renderer = await render("export");
    expect(textOf(renderer.root)).toContain("Checking your export");
    expect(mocks.startDataExport).not.toHaveBeenCalled();
  });

  it("retains a restored job on non404 failure and retries its read without starting another job", async () => {
    window.sessionStorage.setItem(storageKey, jobId);
    mocks.getDataExportStatus.mockRejectedValueOnce(new ApiError(503, "offline"));
    const renderer = await render("export");
    expect(textOf(renderer.root)).toContain("Couldn't check your export");
    expect(window.sessionStorage.getItem(storageKey)).toBe(jobId);
    await click(renderer, "Try again");
    expect(mocks.getDataExportStatus).toHaveBeenLastCalledWith(jobId);
    expect(mocks.startDataExport).not.toHaveBeenCalled();
    expect(textOf(renderer.root)).toContain("Your archive is ready");
  });

  it("does not present cached ready status as current after its read fails", async () => {
    window.sessionStorage.setItem(storageKey, jobId);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["data-export", "status", jobId], { jobId, status: "ready" });
    mocks.getDataExportStatus.mockRejectedValueOnce(new ApiError(503, "offline"));
    const renderer = await render("export", client);
    expect(textOf(renderer.root)).toContain("Couldn't check your export");
    expect(textOf(renderer.root)).not.toContain("Your archive is ready");
    expect(
      renderer.root.findAll((node) => node.type === "a" && textOf(node) === "Download")
    ).toHaveLength(0);
  });

  it("recovers a ready export whose expiresAt is already past without offering Download", async () => {
    window.sessionStorage.setItem(storageKey, jobId);
    mocks.getDataExportStatus.mockResolvedValue({
      jobId,
      status: "ready",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    const renderer = await render("export");
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(textOf(renderer.root)).toContain("Prepare export");
    expect(
      renderer.root.findAll((node) => node.type === "a" && textOf(node) === "Download")
    ).toHaveLength(0);
    expect(mocks.startDataExport).not.toHaveBeenCalled();
  });

  it("removes Download when ready expiresAt crosses while the pane stays open", async () => {
    window.sessionStorage.setItem(storageKey, jobId);
    mocks.getDataExportStatus.mockResolvedValue({
      jobId,
      status: "ready",
      expiresAt: new Date(Date.now() + 1_000).toISOString()
    });
    const renderer = await render("export");
    expect(textOf(renderer.root)).toContain("Your archive is ready");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });
    await settle();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(textOf(renderer.root)).toContain("Prepare export");
    expect(
      renderer.root.findAll((node) => node.type === "a" && textOf(node) === "Download")
    ).toHaveLength(0);
    expect(mocks.startDataExport).not.toHaveBeenCalled();
  });

  it("still resets an owner-inaccessible or expired job", async () => {
    window.sessionStorage.setItem(storageKey, jobId);
    mocks.getDataExportStatus.mockRejectedValueOnce(new ApiError(404, "Not found"));
    const renderer = await render("export");
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(textOf(renderer.root)).toContain("Prepare export");
    expect(mocks.startDataExport).not.toHaveBeenCalled();
  });
});
