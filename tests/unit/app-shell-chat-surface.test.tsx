/**
 * #1284 — app-shell.tsx is the one file that closes the per-surface-chat gap: everything else
 * (turn/privacy/stream routes, session keying) already reads a surface end-to-end. These tests
 * assert only the SURFACE ARGUMENT the shell derives and passes around, not SSE behaviour — the
 * repo ships no DOM test environment (see error-boundary.test.tsx), so rendering goes through
 * `renderToString`, and `useChatStream` is mocked at the exact specifier app-shell.tsx imports
 * (`../chat/use-chat-stream`, resolved here as `apps/web/src/chat/use-chat-stream.js`). Mocking a
 * path that resolves to nothing would silently do nothing while the real hook's effect (harmless
 * under SSR, but load-bearing the moment this repo gains a DOM test environment) still exists —
 * pin the mock to the real resolved module, not a plausible-looking guess.
 *
 * `useSyncExternalStore`'s server-snapshot argument means AppShell reads the module-surface
 * singleton (handle.ts's `getActiveModuleSurface`) synchronously during render, with no effect
 * required — so "a module sets a key" is simulated by calling the REAL `createAssistantSurfaceHandle`
 * handle's `setSurfaceKey` as a plain function call before `renderToString`, exactly the call a
 * mounted module makes, just without a DOM to mount it into.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import {
  DEFAULT_CHAT_SURFACE,
  normalizeChatSurface,
  type MeResponse,
  type ModuleDto
} from "@moss/shared";
import type { TranscriptRecord } from "../../apps/web/src/chat/use-chat-stream.js";

// #1284 — pre-existing, unrelated gap: theme-storage.ts's exported loaders default their `storage`
// param to the bare `localStorage` global, which doesn't exist under Node (this repo's SSR-only
// test convention, see the file header). AppShell's initial `useState(() => loadShellTheme())`
// call hits that default every render, so a stub is required just to get AppShell to render at
// all — nothing to do with the #1284 surface wiring itself.
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined
} as unknown as Storage);

const useChatStreamMock = vi.fn((surface?: string) => ({
  records: [] as readonly TranscriptRecord[],
  clearRecords: vi.fn(),
  streamErrorCount: 0
}));

// Pinned to the exact resolved file app-shell.tsx imports (`../chat/use-chat-stream`) — see the
// file-level comment for why a plausible-but-wrong specifier would silently no-op here.
vi.mock("../../apps/web/src/chat/use-chat-stream.js", () => ({
  useChatStream: (surface?: string) => useChatStreamMock(surface)
}));

// #1284 — ChatDrawer returns null while closed (AppShell's chatOpen starts false, and nothing in
// this harness opens it), so the real component would never expose the `records` prop it was
// actually handed. A minimal stand-in that just records its props is enough to observe
// recordsForSurface's drawer-isolation behaviour (test 6) without a DOM.
const chatDrawerRecordsCalls: (readonly TranscriptRecord[])[] = [];
const chatDrawerSurfaceCalls: string[] = [];
vi.mock("../../apps/web/src/chat/chat-drawer.js", () => ({
  ChatDrawer: (props: { records: readonly TranscriptRecord[]; surface: string }) => {
    chatDrawerRecordsCalls.push(props.records);
    chatDrawerSurfaceCalls.push(props.surface);
    return null;
  }
}));

const { createAssistantSurfaceHandle } =
  await import("../../apps/web/src/chat/assistant-surface/handle.js");
const { moduleChatSurface } = await import("../../apps/web/src/shell/chat-surface-key.js");
const { AppShell } = await import("../../apps/web/src/shell/app-shell.js");

const ME: MeResponse = {
  user: {
    id: "user-1",
    email: "user@example.com",
    emailVerified: true,
    name: "Test User",
    isInstanceAdmin: false,
    status: "active",
    isBootstrapOwner: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

const MODULES: readonly ModuleDto[] = [];

/**
 * Renders AppShell wrapped in the providers it needs (react-query, react-router), and returns the
 * surface argument the (mocked) useChatStream call received for that render. `key` simulates a
 * module claiming (non-null) or releasing (null) the shell's one chat surface via a REAL handle
 * from createAssistantSurfaceHandle — the same call `apps/web/src/app.tsx`'s ExternalModuleMount
 * makes — called directly rather than through a mounted child, since renderToString is a single
 * top-down pass: a child mutating the singleton during ITS OWN render would always be one render
 * too late to affect the parent's already-evaluated useSyncExternalStore read.
 */
function renderWithModuleMount(moduleId: string | undefined, key: string | null): string {
  const handle = createAssistantSurfaceHandle(() => () => undefined, moduleId);
  handle.setSurfaceKey(key);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/today"] },
        createElement(AppShell, {
          me: ME,
          modules: MODULES,
          modulesLoading: false,
          children: createElement("div", null, "routed content")
        })
      )
    )
  );
}

function lastSurfaceArg(): string | undefined {
  const calls = useChatStreamMock.mock.calls;
  return calls[calls.length - 1]?.[0] as string | undefined;
}

describe("AppShell chat surface wiring (#1284)", () => {
  afterEach(() => {
    // The active-module-surface store is a module-level singleton in handle.ts (by design — see
    // its own doc comment) so it survives across `it()` blocks in this file. Release any claim
    // after every test the same way app.tsx's unmount effect does, or a later test would silently
    // start from a leftover surface instead of "drawer".
    createAssistantSurfaceHandle(() => () => undefined, "cleanup").setSurfaceKey(null);
    useChatStreamMock.mockClear();
    chatDrawerRecordsCalls.length = 0;
  });

  it("opens the drawer surface by default", () => {
    renderWithModuleMount(undefined, null);
    expect(lastSurfaceArg()).toBe(DEFAULT_CHAT_SURFACE);
    // #1533 — ChatDrawer itself must be handed the same surface, not just useChatStream.
    expect(chatDrawerSurfaceCalls.at(-1)).toBe(DEFAULT_CHAT_SURFACE);
    expect(chatDrawerSurfaceCalls.at(-1)).toBe(lastSurfaceArg());
  });

  it("passes a defined surface to useChatStream so the default drawer's rehydration effect can run", () => {
    // #1449 — useChatStream's rehydration effect (listChatThreads + pending-approval fetch) is
    // gated on `if (!surface || !enabled) return`, so any falsy surface silently skips it. This is
    // deliberately its own assertion (not folded into the test above) so it keeps failing against
    // any future regression that passes a defined-but-wrong value through, not only a literal
    // `undefined`.
    renderWithModuleMount(undefined, null);
    const surface = lastSurfaceArg();
    expect(surface).toBeDefined();
    expect(surface).not.toBeUndefined();
  });

  it("keeps the chat control neutral while the persona name is pending (#1451/#1482)", () => {
    const html = renderWithModuleMount(undefined, null);

    expect(html).toContain('aria-label="Open chat"');
    expect(html).not.toContain("Chat with Moss");
  });

  it("switches to the module surface when a module sets a key", () => {
    renderWithModuleMount("job-search", "profile-1");
    expect(lastSurfaceArg()).toBe(moduleChatSurface("job-search", "profile-1"));
    // #1533 — ChatDrawer itself must be handed the same surface, not just useChatStream.
    expect(chatDrawerSurfaceCalls.at(-1)).toBe(moduleChatSurface("job-search", "profile-1"));
    expect(chatDrawerSurfaceCalls.at(-1)).toBe(lastSurfaceArg());
  });

  it("derives a surface the server will actually accept", () => {
    renderWithModuleMount("job-search", "profile-1");
    const surface = lastSurfaceArg();
    expect(surface).toBeDefined();
    // Deliberately not a golden string: this is the assertion that rejected the original
    // `module:<id>:<key>` scheme, which normalizeChatSurface throws on (colons, unbounded length).
    expect(() => normalizeChatSurface(surface)).not.toThrow();
  });

  it("derives a legal surface from hostile inputs", () => {
    const hostileModuleId = `7${"a".repeat(119)}`;
    const hostileKey = "profile one! 🎯 <script>";
    renderWithModuleMount(hostileModuleId, hostileKey);
    const surface = lastSurfaceArg();
    expect(surface).toBeDefined();
    expect(() => normalizeChatSurface(surface)).not.toThrow();
  });

  it("gives two profiles of the same module different surfaces", () => {
    renderWithModuleMount("job-search", "profile-1");
    const first = lastSurfaceArg();
    useChatStreamMock.mockClear();
    renderWithModuleMount("job-search", "profile-2");
    const second = lastSurfaceArg();
    expect(first).not.toBe(second);
  });

  it("shows the live module thread in the drawer while you are inside that module", () => {
    // #1284/#1332 — Ben's ruling, refined 2026-07-28: the drawer shows the chat you are actually
    // in. With a module surface active, opening the header control gives that module's transcript
    // (job-search spec §7), not the empty panel the old DEFAULT_CHAT_SURFACE literal produced.
    useChatStreamMock.mockImplementationOnce(() => ({
      records: [{ kind: "reply", text: "module transcript line" }],
      clearRecords: vi.fn(),
      streamErrorCount: 0
    }));
    renderWithModuleMount("job-search", "profile-1");
    expect(chatDrawerRecordsCalls.at(-1)).toEqual([
      { kind: "reply", text: "module transcript line" }
    ]);
  });

  it("hands the drawer nothing once the module releases the surface", () => {
    // The leakage half of the ruling — the half #1284 actually cares about. Release, then render
    // with the stream mock back at its default empty result, which is what useChatStream(drawer)
    // really returns for a user who has no drawer thread: the module's transcript is gone because
    // the surface key is also the history lookup key, not because anything filters it out.
    renderWithModuleMount("job-search", "profile-1");
    createAssistantSurfaceHandle(() => () => undefined, "job-search").setSurfaceKey(null);
    renderWithModuleMount(undefined, null);
    expect(lastSurfaceArg()).toBe(DEFAULT_CHAT_SURFACE);
    expect(chatDrawerRecordsCalls.at(-1)).toEqual([]);
  });

  it("returns the shell to the drawer once a module releases its surface", () => {
    // Simulates ExternalModuleMount's unmount cleanup (`setSurfaceKey(null)`) firing, then the
    // shell rendering again — the "reset to drawer" half of the setSurfaceKey contract.
    renderWithModuleMount("job-search", "profile-1");
    expect(lastSurfaceArg()).toBe(moduleChatSurface("job-search", "profile-1"));

    createAssistantSurfaceHandle(() => () => undefined, "job-search").setSurfaceKey(null);
    renderWithModuleMount(undefined, null);
    expect(lastSurfaceArg()).toBe(DEFAULT_CHAT_SURFACE);
    // #1533 — ChatDrawer follows the shell back to the default surface too.
    expect(chatDrawerSurfaceCalls.at(-1)).toBe(DEFAULT_CHAT_SURFACE);
  });
});
