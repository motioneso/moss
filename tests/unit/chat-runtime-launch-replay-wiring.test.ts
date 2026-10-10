import { describe, expect, it, vi } from "vitest";
import type * as ChatSessionManagerModule from "../../packages/chat/src/live/chat-session-manager.js";

// #3335: createChatSessionRuntime must hand the launch replay hooks to the manager unchanged.

const capturedDeps: unknown[] = [];

vi.mock("../../packages/chat/src/live/chat-session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChatSessionManagerModule>();
  return {
    ...actual,
    ChatSessionManager: vi.fn().mockImplementation(function FakeChatSessionManager(deps: unknown) {
      capturedDeps.push(deps);
      return {
        shutdown: vi.fn(),
        dropSessionsForProvider: vi.fn(),
        reconcileLiveSessions: vi.fn(async () => {}),
        handleRemoteReap: vi.fn()
      };
    })
  };
});

import { createChatSessionRuntime } from "../../packages/chat/src/live/runtime.js";

describe("createChatSessionRuntime launch replay wiring (#3335)", () => {
  it("forwards begin and end to the manager deps", () => {
    const beginLaunchReplay = vi.fn();
    const endLaunchReplay = vi.fn();
    createChatSessionRuntime({
      dataContext: {
        withDataContext: async (_access: unknown, fn: (db: never) => unknown) => fn({} as never)
      } as never,
      mcpTokenLifecycle: { mint: vi.fn(), revoke: vi.fn(), beginLaunchReplay, endLaunchReplay }
    });

    const deps = capturedDeps.at(-1) as { beginLaunchReplay?: unknown; endLaunchReplay?: unknown };
    expect(deps.beginLaunchReplay).toBe(beginLaunchReplay);
    expect(deps.endLaunchReplay).toBe(endLaunchReplay);
  });
});
