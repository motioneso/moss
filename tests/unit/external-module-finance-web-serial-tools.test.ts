// tests/unit/external-module-finance-web-serial-tools.test.ts
//
// The host page handle answers "failed" to a call made while another is in flight. Finance
// chains its calls, so a second call waits for the first instead of failing unsent.
import { describe, expect, it } from "vitest";

import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";

import { serialTools } from "../../external-modules/finance/src/web/serial-tools.js";

function busyHandle() {
  const calls: string[] = [];
  const pending: Array<(outcome: ModuleToolOutcome | Error) => void> = [];
  let busy = false;
  const handle: ExternalModuleToolsHandleV1 = {
    invoke(name) {
      if (busy) return Promise.resolve({ status: "failed" });
      busy = true;
      calls.push(name);
      return new Promise<ModuleToolOutcome>((resolve, reject) => {
        pending.push((outcome) => {
          busy = false;
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        });
      });
    }
  };
  const settle = async (outcome: ModuleToolOutcome | Error) => {
    pending.shift()?.(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { handle, calls, settle };
}

describe("serialTools", () => {
  it("starts a second call only after the first settles", async () => {
    const host = busyHandle();
    const tools = serialTools(host.handle);
    const first = tools.invoke("finance.manual.context", {});
    const second = tools.invoke("finance.manual.context", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.calls).toEqual(["finance.manual.context"]);

    await host.settle({ status: "succeeded", result: { status: "ok", n: 1 } });
    expect(host.calls).toEqual(["finance.manual.context", "finance.manual.context"]);
    await host.settle({ status: "succeeded", result: { status: "ok", n: 2 } });

    await expect(first).resolves.toEqual({ status: "succeeded", result: { status: "ok", n: 1 } });
    await expect(second).resolves.toEqual({ status: "succeeded", result: { status: "ok", n: 2 } });
  });

  it("keeps going after a call throws", async () => {
    const host = busyHandle();
    const tools = serialTools(host.handle);
    const firstFails = expect(tools.invoke("finance.import.preview", {})).rejects.toThrow(
      "network"
    );
    const second = tools.invoke("finance.import.apply", {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    await host.settle(new Error("network"));
    await firstFails;
    await host.settle({ status: "cancelled" });

    await expect(second).resolves.toEqual({ status: "cancelled" });
    expect(host.calls).toEqual(["finance.import.preview", "finance.import.apply"]);
  });
});
