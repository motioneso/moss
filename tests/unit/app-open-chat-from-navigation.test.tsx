// #1975: Workshop's "Ask for a change" button navigates to a running draft's own page with
// { openChat: true } in router state; ExternalModuleMount (apps/web/src/app.tsx) reads that
// flag once on mount and opens chat. This pins the decision itself — see the function's own
// comment for why it is not tested through a full ExternalModuleMount render.
//
// app.tsx calls installModuleHostRuntime() at module scope (#918), which reads the bare
// `window` global — absent under this repo's default Node test environment. Stub it and import
// app.tsx dynamically afterward, the same way app-persona-boot-gate.test.tsx does; switching to
// the jsdom environment instead drives app.tsx's transitive virtual-module-web fixture through a
// different resolution path that fails to find @moss/sports/web.
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {} as unknown as Window & typeof globalThis);

const { shouldOpenChatFromNavigation } = await import("../../apps/web/src/app.js");

describe("shouldOpenChatFromNavigation", () => {
  it("opens chat when navigating into a draft's page with the openChat flag set", () => {
    expect(shouldOpenChatFromNavigation(true, { openChat: true })).toBe(true);
  });

  it("does not open chat when there is no router state", () => {
    expect(shouldOpenChatFromNavigation(true, null)).toBe(false);
    expect(shouldOpenChatFromNavigation(true, undefined)).toBe(false);
  });

  it("does not open chat when the flag is absent or false", () => {
    expect(shouldOpenChatFromNavigation(true, {})).toBe(false);
    expect(shouldOpenChatFromNavigation(true, { openChat: false })).toBe(false);
  });

  it("does not open chat on a page that is not the caller's own draft, even with the flag set", () => {
    expect(shouldOpenChatFromNavigation(false, { openChat: true })).toBe(false);
  });
});
