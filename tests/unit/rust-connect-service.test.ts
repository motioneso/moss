import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../rust-spike/shell/connect/assets/connect.js", import.meta.url),
  "utf8"
);

function connectScreen() {
  const dom = new JSDOM('<main id="screen"></main>', { runScripts: "outside-only" });
  const messages: Record<string, unknown>[] = [];
  Object.assign(dom.window, {
    ipc: { postMessage: (body: string) => messages.push(JSON.parse(body)) }
  });
  dom.window.eval(source);
  return { dom, messages };
}

describe("native connect service actions", () => {
  it("reopens with a reconnect, preserving the owner's explicit Stop", () => {
    const { dom, messages } = connectScreen();
    expect(messages).toEqual([{ do: "retry" }]);
    dom.window.close();
  });

  it("only sends explicit Start when the owner presses Start on the stopped screen", () => {
    const { dom, messages } = connectScreen();
    dom.window.eval(
      `window.moss.show(${JSON.stringify({
        screen: "problem",
        name: "This computer",
        reason: "Moss is stopped. Press Start.",
        code: "app_server_service_failed",
        local: true,
        retry: false
      })})`
    );
    expect(messages).toEqual([{ do: "retry" }]);
    const start = dom.window.document.querySelector("button");
    expect(start?.textContent).toBe("Start");
    start?.click();
    expect(messages).toEqual([{ do: "retry" }, { do: "start" }]);
    dom.window.close();
  });
});
