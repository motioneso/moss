import { describe, expect, it } from "vitest";

import { openChatDrawer } from "../../tests/uat/visual-parity/shell-navigation.js";

/**
 * A fake drawer with the mounted controls only: Conversations opens an overlay whose
 * "New side chat" clears the drawer surface. There is no "New chat" button to find.
 */
function fakeDrawer(options: { readonly clearResponse?: () => Promise<unknown> } = {}) {
  const state = {
    replies: ["   "] as string[],
    sendCalls: 0,
    overlayOpen: false,
    newSideChatCalls: 0,
    clearWaitStarted: false,
    domCleared: () => {}
  };
  let resolveDomClear!: () => void;
  const domClear = new Promise<void>((resolve) => {
    resolveDomClear = resolve;
  });
  state.domCleared = () => {
    state.replies.length = 0;
    resolveDomClear();
  };
  const clearResponse = {
    url: () => "http://uat.test/api/chat/clear?surface=drawer",
    request: () => ({ method: () => "POST" }),
    status: () => 204
  };
  const nonempty = () => state.replies.filter((text) => text.trim() !== "");
  const replyLocator = {
    filter: () => replyLocator,
    count: async () => nonempty().length,
    last: () => replyLocator,
    nth: (index: number) => ({
      waitFor: async () => {
        if (!nonempty()[index]) throw new Error("fresh reply did not arrive");
      }
    }),
    waitFor: async () => {
      if (nonempty().length === 0) throw new Error("reply did not arrive");
    }
  };
  const page = {
    locator: (selector: string) => {
      if (selector === "header.topbar") return { getByRole: () => ({ click: async () => {} }) };
      if (selector === ".chatd-msg:not(.chatd-msg--me) .chatd-bubble") return replyLocator;
      throw new Error(`unexpected locator: ${selector}`);
    },
    waitForResponse: async (predicate: (response: unknown) => boolean) => {
      state.clearWaitStarted = true;
      if (!predicate(clearResponse)) throw new Error("clear response did not match");
      if (options.clearResponse) return options.clearResponse();
      return clearResponse;
    },
    waitForFunction: async () => (options.clearResponse ? domClear : state.domCleared()),
    getByRole: (role: string, query: { name: string | RegExp }) => {
      if (role === "textbox") {
        const composer = { waitFor: async () => {}, fill: async () => {} };
        return { first: () => composer };
      }
      if (role !== "button") throw new Error(`unexpected role: ${role}`);
      if (query.name === "Close chat") return { waitFor: async () => {} };
      if (query.name === "Open conversations")
        return {
          click: async () => {
            state.overlayOpen = true;
          }
        };
      if (query.name === "New side chat")
        return {
          click: async () => {
            if (!state.overlayOpen) throw new Error("New side chat is inside Conversations");
            state.overlayOpen = false;
            state.newSideChatCalls += 1;
          }
        };
      if (query.name === "Send")
        return {
          click: async () => {
            state.sendCalls += 1;
            state.replies.push(state.sendCalls === 1 ? "first reply" : "fresh second reply");
          }
        };
      throw new Error(`unexpected button: ${String(query.name)}`);
    }
  } as never;
  return { page, state };
}

describe("P1 Chat readiness", () => {
  it("opens twice and requires a fresh nonempty reply after New side chat", async () => {
    const { page, state } = fakeDrawer();

    await openChatDrawer(page);
    expect(state.newSideChatCalls).toBe(0);
    expect(state.replies).toEqual(["   ", "first reply"]);

    await openChatDrawer(page);

    expect(state.newSideChatCalls).toBe(1);
    expect(state.sendCalls).toBe(2);
    expect(state.replies).toEqual(["fresh second reply"]);
  });

  it.each(["clear acknowledgement", "old reply removal"] as const)(
    "does not send before both the clear acknowledgement and the empty DOM (%s last)",
    async (last) => {
      let resolveClear!: (response: unknown) => void;
      const clearResponsePromise = new Promise<unknown>((resolve) => {
        resolveClear = resolve;
      });
      const { page, state } = fakeDrawer({ clearResponse: () => clearResponsePromise });
      const acknowledgeClear = () =>
        resolveClear({
          url: () => "http://uat.test/api/chat/clear?surface=drawer",
          request: () => ({ method: () => "POST" }),
          status: () => 204
        });

      await openChatDrawer(page);
      const secondOpen = openChatDrawer(page);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(state.clearWaitStarted).toBe(true);
      expect(state.newSideChatCalls).toBe(1);
      expect(state.sendCalls).toBe(1);
      if (last === "clear acknowledgement") state.domCleared();
      else acknowledgeClear();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(state.sendCalls).toBe(1);
      if (last === "clear acknowledgement") acknowledgeClear();
      else state.domCleared();
      await secondOpen;
      expect(state.sendCalls).toBe(2);
      expect(state.replies).toEqual(["fresh second reply"]);
    }
  );

  it("refuses a failed New side chat clear without sending", async () => {
    const { page, state } = fakeDrawer({
      clearResponse: async () => ({
        url: () => "http://uat.test/api/chat/clear?surface=drawer",
        request: () => ({ method: () => "POST" }),
        status: () => 500
      })
    });

    await openChatDrawer(page);
    await expect(openChatDrawer(page)).rejects.toThrow("parity-shell: chat clear failed");
    expect(state.sendCalls).toBe(1);
  });
});
