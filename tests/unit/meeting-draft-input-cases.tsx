import { act } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { expect, it, vi, type Mock } from "vitest";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";

type Transport = (path: string, options?: RequestInit) => Promise<Response>;
interface DraftHarness {
  readonly mount: () => Promise<void>;
  readonly host: () => HTMLDivElement;
  readonly client: () => QueryClient;
  readonly transport: () => Mock<Transport>;
  readonly calls: () => { path: string; body: Record<string, unknown> | undefined }[];
  readonly settle: () => Promise<void>;
  readonly click: (text: string) => Promise<void>;
}
const title = "UAT meeting draft 82a1900a-f6a0-4353-86d3-af258952b98b";
function typeWithoutEffectFlush(input: HTMLInputElement, text: string) {
  const errors: string[] = [];
  const report = (event: ErrorEvent) => {
    errors.push(event.message);
    event.preventDefault();
  };
  window.addEventListener("error", report);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  try {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    // act per character flushes React's pending work and hides the production crash.
    // Keep query notifications deferred while discrete input events update the DOM.
    for (const character of text) {
      setter.call(input, input.value + character);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } finally {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.removeEventListener("error", report);
  }
  return errors;
}
/** Synthetic DOM/transport regression, not live-browser acceptance evidence. */
export function registerDraftInputRegressions(h: DraftHarness) {
  it("keeps the full title without a nested-update crash before query notifications flush", async () => {
    await h.mount();
    const input = h.host().querySelector<HTMLInputElement>("#meeting-title")!;
    input.focus();
    const errors = typeWithoutEffectFlush(input, title);
    expect(input.value).toBe(title);
    expect(errors).toEqual([]);
    expect(h.calls().some((call) => call.path === "/api/meetings/records")).toBe(false);
    expect(h.client().getQueryData(["meetings", "setup-draft"])).toMatchObject({ title });
    await h.settle();
    expect(input.value).toBe(title);
  });
  it("retains the focused title through delayed preferences and draft-creation responses", async () => {
    await h.mount();
    const normal = h.transport().getMockImplementation()!;
    let releasePreferences!: () => void;
    let releaseCreate!: () => void;
    h.transport().mockImplementation(async (path, options) => {
      if (path === "/api/meetings/preferences")
        await new Promise<void>((resolve) => {
          releasePreferences = resolve;
        });
      if (path === "/api/meetings/records")
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
      return normal(path, options);
    });
    act(() => {
      void h.client().invalidateQueries({ queryKey: meetingKeys.preferences });
    });
    const input = h.host().querySelector<HTMLInputElement>("#meeting-title")!;
    input.focus();
    expect(typeWithoutEffectFlush(input, title.slice(0, 30))).toEqual([]);
    await act(async () => releasePreferences());
    expect(document.activeElement).toBe(input);
    expect(typeWithoutEffectFlush(input, title.slice(30))).toEqual([]);
    expect(input.value).toBe(title);
    await h.click("Create draft");
    expect(input.disabled).toBe(true);
    expect(input.value).toBe(title);
    await act(async () => releaseCreate());
    await h.settle();
    expect(h.calls().find((call) => call.path === "/api/meetings/records")?.body?.title).toBe(
      title
    );
  });
}
