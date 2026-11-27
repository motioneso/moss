// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("rust-spike/shell/connect/assets/connect.js", "utf8");
const restoreSource = readFileSync("rust-spike/shell/connect/assets/restore.js", "utf8");

function connectScreen() {
  document.body.innerHTML = '<main id="screen"></main>';
  const messages: Record<string, unknown>[] = [];
  Object.assign(window, {
    ipc: { postMessage: (body: string) => messages.push(JSON.parse(body)) }
  });
  window.eval(restoreSource);
  window.eval(source);
  return { messages };
}

describe("native connect service actions", () => {
  it("reopens with a reconnect, preserving the owner's explicit Stop", () => {
    const { messages } = connectScreen();
    expect(messages).toEqual([{ do: "retry" }]);
  });

  it("only sends explicit Start when the owner presses Start on the stopped screen", () => {
    const { messages } = connectScreen();
    window.eval(
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
    const start = window.document.querySelector("button");
    expect(start?.textContent).toBe("Start");
    start?.click();
    expect(messages).toEqual([{ do: "retry" }, { do: "start" }]);
  });
});
