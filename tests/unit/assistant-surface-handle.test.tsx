import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssistantSurface,
  AssistantSurfaceHostProvider
} from "../../apps/web/src/chat/assistant-surface/index.js";
import { createAssistantSurfaceHandle } from "../../apps/web/src/chat/assistant-surface/handle.js";
import { moduleChatSurface } from "../../apps/web/src/shell/chat-surface-key.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";

// React/web unit tests use .tsx so root NodeNext typecheck does not reinterpret Vite imports.
afterEach(() => {
  createAssistantSurfaceHandle(() => () => undefined, "cleanup").setSurfaceKey(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createAssistantSurfaceHandle", () => {
  it("binds turn, upload, composer, and record subscription to host services", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/chat/turn")) {
        return Response.json({ reply: "ok" });
      }
      if (url.endsWith("/api/chat/attachments")) {
        return Response.json({
          attachment: {
            id: "attachment-1",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3
          }
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const unsubscribe = vi.fn();
    const subscribeRecords = vi.fn(() => unsubscribe);
    const seedComposer = vi.fn();
    const handle = createAssistantSurfaceHandle(subscribeRecords, undefined, seedComposer);

    expect(handle.Surface).toBe(AssistantSurface);
    expect(handle.subscribeRecords).toBe(subscribeRecords);
    expect(handle.subscribeRecords(vi.fn())).toBe(unsubscribe);
    handle.seedComposer("Please revise the summary");
    expect(seedComposer).toHaveBeenCalledWith("Please revise the summary");

    await handle.submitTurn({
      text: "Use these titles",
      controlContext: { step: "profile", action: "save" },
      attachmentIds: ["attachment-1"]
    });
    await expect(
      handle.uploadAttachment(new File(["pdf"], "report.pdf", { type: "application/pdf" }))
    ).resolves.toEqual({ id: "attachment-1", fileName: "report.pdf", sizeBytes: 3 });

    const turnCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/chat/turn"));
    expect(turnCall?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          text: "Use these titles",
          controlContext: { step: "profile", action: "save" },
          attachmentIds: ["attachment-1"]
        })
      })
    );
  });

  it("scopes turns and record subscription to its host-controlled chat surface", async () => {
    // #1284 — the module never names a surface directly: setSurfaceKey takes an opaque key, and
    // the handle derives the wire surface by combining it with the host-bound moduleId. Before any
    // setSurfaceKey call, the handle has no claimed surface at all (see the next test).
    const fetchMock = vi.fn(async () => Response.json({ reply: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const unsubscribe = vi.fn();
    const subscribeRecords = vi.fn(() => unsubscribe);
    const handle = createAssistantSurfaceHandle(subscribeRecords, "demo-module");
    const expectedSurface = moduleChatSurface("demo-module", "profile-1");

    handle.setSurfaceKey("profile-1");
    handle.subscribeRecords(vi.fn());
    await handle.submitTurn({ text: "hello" });

    expect(subscribeRecords).toHaveBeenCalledWith(expect.any(Function), expectedSurface);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/turn",
      expect.objectContaining({
        body: JSON.stringify({ text: "hello", surface: expectedSurface })
      })
    );
  });

  it("rerenders the embedded surface when its profile key changes", async () => {
    const handle = createAssistantSurfaceHandle(() => () => undefined, "job-search");
    const firstSurface = moduleChatSurface("job-search", "profile-1");
    const secondSurface = moduleChatSurface("job-search", "profile-2");
    let renderer: ReactTestRenderer;

    // AssistantSurface reads the configured assistant name via useAssistantName (react-query), so
    // rendering it needs a QueryClientProvider ancestor; prime the cache to avoid a real fetch.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.settings.persona, {
      persona: { assistantName: "Alfred", personaText: "" }
    });

    handle.setSurfaceKey("profile-1");
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            AssistantSurfaceHostProvider,
            {
              value: {
                records: [],
                recordsForSurface: (surface) => [
                  {
                    kind: "reply",
                    text: surface === firstSurface ? "First profile" : "Second profile"
                  }
                ],
                registerComposer: () => () => undefined,
                subscribeRecords: () => () => undefined
              }
            },
            createElement(handle.Surface)
          )
        )
      );
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("First profile");

    await act(async () => handle.setSurfaceKey("profile-2"));
    const switched = JSON.stringify(renderer!.toJSON());
    expect(switched).toContain("Second profile");
    expect(switched).not.toContain("First profile");
    expect(secondSurface).not.toBe(firstSurface);
  });

  it("returns to the unclaimed (rejecting) state on setSurfaceKey(null), not the drawer", async () => {
    // #1495 — release must not restore the pre-#1495 drawer-fallback behaviour: a module that
    // releases its claim goes back to unclaimed, which now rejects, exactly as before any claim.
    const fetchMock = vi.fn(async () => Response.json({ reply: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const subscribeRecords = vi.fn(() => vi.fn());
    const handle = createAssistantSurfaceHandle(subscribeRecords, "demo-module");

    handle.setSurfaceKey("profile-1");
    handle.setSurfaceKey(null);

    await expect(handle.submitTurn({ text: "hello" })).rejects.toThrow(/demo-module/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects seedContext and submitTurn on a module-bound handle before any surface claim", async () => {
    // #1495 — the pre-claim ordering gap: seed/turn must fail loud with no network call, never
    // fall through to the drawer.
    const fetchMock = vi.fn(async () => Response.json({ reply: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const subscribeRecords = vi.fn(() => vi.fn());
    const handle = createAssistantSurfaceHandle(subscribeRecords, "demo-module");

    await expect(handle.seedContext("seed text", "idem-1")).rejects.toThrow(/demo-module/);
    await expect(handle.submitTurn({ text: "hello" })).rejects.toThrow(/demo-module/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops subscribeRecords on a module-bound handle before any surface claim", () => {
    // #1495 — the read-side twin: no records delivered, host subscription never reached with the
    // drawer surface, and the gap is logged rather than silent.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const subscribeRecords = vi.fn(() => vi.fn());
    const handle = createAssistantSurfaceHandle(subscribeRecords, "demo-module");
    const listener = vi.fn();

    const unsubscribe = handle.subscribeRecords(listener);
    unsubscribe();

    expect(subscribeRecords).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("demo-module"));
  });

  it("leaves drawer-bound handles (no moduleId) unaffected by claim enforcement", async () => {
    // #1495 — enforcement is module-bound only; a handle with no moduleId can never derive a
    // surface (setSurfaceKey fails closed on it), so its operations must keep working unclaimed.
    const fetchMock = vi.fn(async () => Response.json({ reply: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const subscribeRecords = vi.fn(() => vi.fn());
    const handle = createAssistantSurfaceHandle(subscribeRecords);

    await handle.seedContext("seed text", "idem-1");
    await handle.submitTurn({ text: "hello" });
    handle.subscribeRecords(vi.fn());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(subscribeRecords).toHaveBeenCalledTimes(1);
  });
});
