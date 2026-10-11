import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listWellnessCheckins,
  listWellnessCheckinsInWindow
} from "../../apps/web/src/api/client.js";
const since = "2026-10-01T00:00:00.000Z";
function mockPages(pages: readonly unknown[]) {
  let index = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(pages[index++]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe("complete Wellness window client reads", () => {
  it("preserves the old numeric limit argument", async () => {
    const fetch = mockPages([{ checkins: [] }]);
    await listWellnessCheckins(42);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/wellness/checkins?limit=42");
  });
  it("drains every cursor with the same since filter and encodes opaque values", async () => {
    const fetch = mockPages([
      { checkins: [{ id: "one" }], nextCursor: "next+/=" },
      { checkins: [{ id: "two" }], nextCursor: null }
    ]);
    const data = await listWellnessCheckinsInWindow(since);
    expect(data.checkins).toEqual([{ id: "one" }, { id: "two" }]);
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!, "https://moss.example").searchParams.get("since")).toBe(since);
    expect(new URL(urls[1]!, "https://moss.example").searchParams.get("cursor")).toBe("next+/=");
  });
  it("rejects a mid-window failure instead of returning incomplete statistics", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ checkins: [{ id: "one" }], nextCursor: "two" }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "unavailable" }), { status: 503 })
      );
    vi.stubGlobal("fetch", fetch);
    await expect(listWellnessCheckinsInWindow(since)).rejects.toThrow();
  });
  it("rejects a full legacy page whose continuation status is unknown", async () => {
    mockPages([{ checkins: Array.from({ length: 500 }, (_, id) => ({ id })) }]);
    await expect(listWellnessCheckinsInWindow(since)).rejects.toThrow("complete");
  });
  it("rejects repeated cursors rather than loop or duplicate pages", async () => {
    mockPages([
      { checkins: [], nextCursor: "repeat" },
      { checkins: [], nextCursor: "repeat" }
    ]);
    await expect(listWellnessCheckinsInWindow(since)).rejects.toThrow("cursor");
  });
});
