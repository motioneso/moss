/**
 * #2164 r21 — `createChatSessionRuntime` must forward `deps.mcpTokenLifecycle?.getToolsListObservationCount`
 * into the `ChatSessionManager` constructor deps as `getToolsListObservationCount`, the same "adopt one
 * optional field" pattern already used for `waitForToolsListReady` (#2159). This only proves the wiring —
 * the guard's own behavior against a real `SessionTokenRegistry` is covered by
 * `session-tokens-observation-count.test.ts`, and `ChatSessionManager`'s use of the field by
 * `chat-session-manager-mcp-readiness.test.ts`.
 *
 * `ChatSessionManager` is mocked (same approach as `chat-runtime-persistent-pool-wiring.test.ts`'s
 * `ClaudePersistentRuntime` mock) so the constructor call can be inspected directly, with no real
 * engine, DB, or tmux touched.
 */
import { describe, expect, it, vi } from "vitest";
import type * as ChatSessionManagerModule from "../../packages/chat/src/live/chat-session-manager.js";

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

function fakeDataContext() {
  return {
    withDataContext: async (
      _access: { readonly actorUserId: string; readonly requestId: string },
      fn: (db: never) => unknown
    ) => fn({} as never)
  } as never;
}

describe("createChatSessionRuntime — getToolsListObservationCount wiring (#2164 r21)", () => {
  it("forwards mcpTokenLifecycle.getToolsListObservationCount to the manager deps unchanged", () => {
    capturedDeps.length = 0;
    const getToolsListObservationCount = vi.fn().mockReturnValue(3);

    createChatSessionRuntime({
      dataContext: fakeDataContext(),
      mcpTokenLifecycle: {
        mint: vi.fn(),
        revoke: vi.fn(),
        touch: vi.fn(),
        reconcile: vi.fn(),
        listSessionIds: vi.fn(),
        waitForReady: vi.fn(),
        getToolsListObservationCount
      }
    });

    const deps = capturedDeps.at(-1) as { getToolsListObservationCount?: unknown };
    expect(deps.getToolsListObservationCount).toBe(getToolsListObservationCount);
  });

  it("leaves getToolsListObservationCount undefined when mcpTokenLifecycle is absent — unchanged pre-r21 behavior", () => {
    capturedDeps.length = 0;

    createChatSessionRuntime({ dataContext: fakeDataContext() });

    const deps = capturedDeps.at(-1) as { getToolsListObservationCount?: unknown };
    expect(deps.getToolsListObservationCount).toBeUndefined();
  });
});
