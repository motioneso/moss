import { describe, expect, it } from "vitest";

import { openChatDrawer } from "../../tests/uat/visual-parity/shell-navigation.js";

describe("P1 Chat readiness", () => {
  it("opens twice and requires a fresh nonempty reply after New chat", async () => {
    let newChatCalls = 0;
    let sendCalls = 0;
    const replies: string[] = ["   "];
    const replyLocator = {
      filter: () => replyLocator,
      count: async () => replies.filter((text) => text.trim() !== "").length,
      last: () => replyLocator,
      nth: (index: number) => ({
        waitFor: async () => {
          if (!replies[index]?.trim()) throw new Error("fresh reply did not arrive");
        }
      }),
      waitFor: async () => {
        await Promise.resolve();
        if (!replies.some((text) => text.trim() !== "")) throw new Error("reply did not arrive");
      }
    };
    const page = {
      locator: (selector: string) => {
        if (selector === "header.topbar") return { getByRole: () => ({ click: async () => {} }) };
        if (selector === ".chatd-msg:not(.chatd-msg--me) .chatd-bubble") return replyLocator;
        throw new Error(`unexpected locator: ${selector}`);
      },
      waitForResponse: async (predicate: (response: unknown) => boolean) => {
        const response = {
          url: () => "http://uat.test/api/chat/clear?surface=drawer",
          request: () => ({ method: () => "POST" }),
          status: () => 204
        };
        if (!predicate(response)) throw new Error("clear response did not match");
        return response;
      },
      waitForFunction: async () => {},
      getByRole: (role: string, options: { name: string | RegExp }) => {
        if (role === "textbox") {
          const composer = { waitFor: async () => {}, fill: async () => {} };
          return { first: () => composer };
        }
        if (role !== "button") throw new Error(`unexpected role: ${role}`);
        if (options.name === "Close chat") return { waitFor: async () => {} };
        if (options.name === "New chat")
          return {
            count: async () => (newChatCalls++ === 0 ? 0 : 1),
            click: async () => {}
          };
        if (options.name === "Send")
          return {
            click: async () => {
              sendCalls += 1;
              replies.push(sendCalls === 1 ? "first reply" : "fresh second reply");
            }
          };
        throw new Error(`unexpected button: ${String(options.name)}`);
      }
    } as never;

    await openChatDrawer(page);
    await openChatDrawer(page);

    expect(sendCalls).toBe(2);
    expect(replies).toContain("fresh second reply");
  });

  it("does not send until New chat clear is acknowledged and the DOM is empty", async () => {
    let newChatCalls = 0;
    let sendCalls = 0;
    let clearWaitStarted = false;
    const replies: string[] = ["   "];
    const releaseClear = () => resolveClear(clearResponse);
    const clearOldReplies = () => {
      replies.length = 0;
      resolveDomClear();
    };
    let resolveClear!: (response: unknown) => void;
    let resolveDomClear!: () => void;
    const clearResponsePromise = new Promise<unknown>((resolve) => {
      resolveClear = resolve;
    });
    const domClearPromise = new Promise<void>((resolve) => {
      resolveDomClear = resolve;
    });
    const clearResponse = {
      url: () => "http://uat.test/api/chat/clear?surface=drawer",
      request: () => ({ method: () => "POST" }),
      status: () => 204
    };
    const replyLocator = {
      filter: () => replyLocator,
      count: async () => replies.filter((text) => text.trim() !== "").length,
      last: () => replyLocator,
      nth: (index: number) => ({
        waitFor: async () => {
          if (!replies[index]?.trim()) throw new Error("fresh reply did not arrive");
        }
      }),
      waitFor: async () => {
        if (!replies.some((text) => text.trim() !== "")) throw new Error("reply did not arrive");
      }
    };
    const page = {
      locator: (selector: string) => {
        if (selector === "header.topbar") return { getByRole: () => ({ click: async () => {} }) };
        if (selector === ".chatd-msg:not(.chatd-msg--me) .chatd-bubble") return replyLocator;
        throw new Error(`unexpected locator: ${selector}`);
      },
      waitForResponse: async (predicate: (response: unknown) => boolean) => {
        clearWaitStarted = true;
        if (!predicate(clearResponse)) throw new Error("clear response did not match");
        return clearResponsePromise;
      },
      waitForFunction: async () => domClearPromise,
      getByRole: (role: string, options: { name: string | RegExp }) => {
        if (role === "textbox") {
          const composer = { waitFor: async () => {}, fill: async () => {} };
          return { first: () => composer };
        }
        if (role !== "button") throw new Error(`unexpected role: ${role}`);
        if (options.name === "Close chat") return { waitFor: async () => {} };
        if (options.name === "New chat")
          return {
            count: async () => (newChatCalls++ === 0 ? 0 : 1),
            click: async () => {}
          };
        if (options.name === "Send")
          return {
            click: async () => {
              sendCalls += 1;
              replies.push("fresh reply");
            }
          };
        throw new Error(`unexpected button: ${String(options.name)}`);
      }
    } as never;

    await openChatDrawer(page);
    const secondOpen = openChatDrawer(page);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(clearWaitStarted).toBe(true);
    expect(sendCalls).toBe(1);
    releaseClear();
    await Promise.resolve();
    expect(sendCalls).toBe(1);
    clearOldReplies();
    await secondOpen;
    expect(sendCalls).toBe(2);
    expect(replies).toContain("fresh reply");
  });
});
