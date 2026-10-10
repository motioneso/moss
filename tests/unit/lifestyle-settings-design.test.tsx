// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WellnessSettings from "../../packages/wellness/src/settings/index.js";
import EmailSettings from "../../packages/email/src/settings/index.js";

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
  });
}
function fail(queryClient: QueryClient, queryKey: readonly unknown[]) {
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey })
    .setState({ status: "error", error: new Error("Read failed"), fetchStatus: "idle" });
}
function renderSettings(queryClient: QueryClient, wellness = true) {
  return renderToString(
    <QueryClientProvider client={queryClient}>
      {wellness ? <WellnessSettings /> : <EmailSettings />}
    </QueryClientProvider>
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("Unverified settings are never presented as saved switches", () => {
  it.each([true, false])(
    "shows a loading sentence instead of interactive defaults (wellness=%s)",
    (wellness) => {
      const html = renderSettings(client(), wellness);
      expect(html).toContain("Loading");
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("Could not save");
    }
  );
  it("offers a Wellness read retry without confusing it with save failure", () => {
    const queryClient = client();
    fail(queryClient, ["wellness", "ai-consent"]);
    const html = renderSettings(queryClient);
    expect(html).toContain("Could not load Wellness AI access");
    expect(html).toContain("Try again");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Could not save");
  });
  it("offers Email read retry and prevents partial reads from authorizing default changes", () => {
    const queryClient = client();
    queryClient.setQueryData(["settings", "source-behaviors"], { sources: [] });
    fail(queryClient, ["email", "briefing-settings"]);
    const html = renderSettings(queryClient, false);
    expect(html).toContain("Could not load email settings");
    expect(html).toContain("Try again");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Could not save");
  });
  it("retains the last confirmed Wellness choice on refresh failure", () => {
    const queryClient = client();
    queryClient.setQueryData(["wellness", "ai-consent"], { effective: false, explicit: false });
    fail(queryClient, ["wellness", "ai-consent"]);
    const html = renderSettings(queryClient);
    expect(html).toContain("Showing the last saved choice");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
  });
  it("announces a failed Wellness write while preserving the confirmed value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const queryClient = client();
    queryClient.setQueryData(["wellness", "ai-consent"], { effective: false, explicit: false });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <WellnessSettings />
        </QueryClientProvider>
      );
    });
    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(renderer.root.findByType("input").props.checked).toBe(false);
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});
