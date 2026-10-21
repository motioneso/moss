import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import type { CompanionDevicesService } from "@moss/auth";
import { createRingRecordingResolver } from "../../apps/api/src/ring-recording-auth.js";

const owner = "00000000-0000-4000-8000-000000000001";
function setup() {
  const resolve = vi.fn(async () => ({ actorUserId: owner, requestId: "test", deviceId: "phone" }));
  const ringDevices: CompanionDevicesService = {
    resolve,
    heartbeat: vi.fn(),
    rename: vi.fn(),
    logoutCredential: vi.fn()
  };
  const ordinary = vi.fn(async () => ({ actorUserId: owner, requestId: "ordinary" }));
  return {
    resolve,
    ordinary,
    run: createRingRecordingResolver({ ringDevices, resolveAccessContext: ordinary })
  };
}
function request(url: string, method = "GET", headers: Record<string, string> = {}) {
  return {
    url,
    method,
    id: "test",
    headers: { authorization: `Bearer vr1_${"a".repeat(43)}`, ...headers }
  } as FastifyRequest;
}
describe("ring credential route boundary", () => {
  it("authenticates only recording receivers and a single voice status read", async () => {
    const state = setup();
    for (const [method, url] of [
      ["POST", "/api/meetings/recording-uploads"],
      ["PUT", "/api/meetings/recording-uploads/id/wav/0"],
      ["POST", "/api/meetings/voice-recordings"],
      ["GET", `/api/chat/voice-requests/${owner}`]
    ])
      expect(await state.run(request(url!, method!))).toEqual({
        actorUserId: owner,
        requestId: "test"
      });
    expect(state.ordinary).not.toHaveBeenCalled();
  });
  it("cannot list/send chat, read meetings or enter other account APIs", async () => {
    const state = setup();
    for (const [method, url] of [
      ["GET", "/api/chat/voice-requests"],
      ["POST", `/api/chat/voice-requests/${owner}/send`],
      ["GET", "/api/meetings"],
      ["GET", "/api/tasks"],
      ["POST", "/api/companion/focus/judge"]
    ])
      await expect(state.run(request(url!, method!))).rejects.toMatchObject({ statusCode: 403 });
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it("rejects delegation and unavailable Android auth rather than falling back", async () => {
    const state = setup();
    await expect(
      state.run(request("/api/meetings/voice-recordings", "POST", { "x-moss-act-as": "any" }))
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createRingRecordingResolver({ resolveAccessContext: state.ordinary })(
        request("/api/meetings/recording-uploads", "POST")
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(state.ordinary).not.toHaveBeenCalled();
  });
  it("preserves ordinary browser authentication", async () => {
    const state = setup(),
      input = request("/api/meetings/recording-uploads", "POST");
    delete input.headers.authorization;
    input.headers.cookie = "synthetic";
    expect(await state.run(input)).toEqual({ actorUserId: owner, requestId: "ordinary" });
    expect(state.resolve).not.toHaveBeenCalled();
  });
});
