import { afterEach, expect, it, vi } from "vitest";
import type { ChatSurface } from "@moss/shared";
import { sendChatTurn, switchChatProvider } from "../../apps/web/src/api/client.js";
import { moduleChatSurface } from "../../apps/web/src/shell/chat-surface-key.js";

afterEach(() => vi.unstubAllGlobals());

it("sends chat turns without page context", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ reply: "hello" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  await sendChatTurn("hello");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/chat/turn",
    expect.objectContaining({ body: JSON.stringify({ text: "hello" }) })
  );
});

it("switches chat provider with a bare URL when no surface is given", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  await switchChatProvider();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/chat/switch",
    expect.objectContaining({ method: "POST" })
  );
});

it("switches chat provider scoped to the given surface", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  const surface = moduleChatSurface("job-search", "profile-1") as ChatSurface;
  await switchChatProvider(surface);
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/chat/switch?surface=${encodeURIComponent(surface)}`,
    expect.objectContaining({ method: "POST" })
  );
});
