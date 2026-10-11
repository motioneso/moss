// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDraft } from "../../packages/meetings/src/web/session-draft.js";

const key = ["meetings", "draft-boundary"] as const;
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let draft: ReturnType<typeof useSessionDraft<{ text: string }>>;
function Draft() {
  draft = useSessionDraft(key, () => ({ text: "" }));
  return null;
}
async function mount() {
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Draft />
      </QueryClientProvider>
    )
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
});

describe("draft boundaries while views are unmounted", () => {
  it("rejects a delayed draft write after unmount, reset and remount", async () => {
    const old = draft;
    await act(async () => {
      old.update(() => ({ text: "Old account" }));
      root.unmount();
    });
    await act(async () => {
      await client.resetQueries();
    });
    expect(old.currentSession()).toBe(false);
    await mount();
    await act(async () => draft.update(() => ({ text: "New account" })));
    await act(async () => old.update(() => ({ text: "Late old save" })));
    expect(client.getQueryData(key)).toEqual({ text: "New account" });
    expect(draft.currentSession()).toBe(true);
  });
  it("keeps an authorized pending draft write alive across normal navigation", async () => {
    const old = draft;
    await act(async () => {
      old.update(() => ({ text: "Before navigation" }));
      root.unmount();
    });
    expect(old.currentSession()).toBe(true);
    await act(async () => old.update(() => ({ text: "Saved after navigation" })));
    await mount();
    expect(draft.data).toEqual({ text: "Saved after navigation" });
  });
});
