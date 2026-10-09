// Getting started (#3178): finance.setup.status reports key and bank state.
import { describe, expect, it } from "vitest";

import { setupStatusHandler } from "../../external-modules/finance/src/worker/handlers/setup.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

function ports(opts: { keys: boolean; items: number }): WorkerPorts {
  return {
    creds: {
      get: async () => {
        if (!opts.keys) throw new Error("needs_config");
        return { clientId: "id", secret: "secret" };
      }
    },
    store: async () => ({ listItems: async () => Array.from({ length: opts.items }, () => ({})) })
  } as unknown as WorkerPorts;
}

describe("finance.setup.status", () => {
  it("reports missing keys and no bank", async () => {
    expect(await setupStatusHandler(ports({ keys: false, items: 0 }))({})).toEqual({
      keysConfigured: false,
      hasBank: false
    });
  });
  it("reports keys and a linked bank, without returning the keys", async () => {
    const result = await setupStatusHandler(ports({ keys: true, items: 1 }))({});
    expect(result).toEqual({ keysConfigured: true, hasBank: true });
  });
});
