import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  enablePush,
  PushCleanupIncompleteError,
  removePushDevice,
  type PendingRemovalStore,
  type PushServiceWorkerContainer
} from "../../apps/web/src/settings/push-browser-subscription.js";

// #2308: removing this browser's device must also unsubscribe the browser's own push
// subscription, and the browser and server must not drift apart when a step fails.

function hashOf(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("hex");
}

interface FakeSubscription {
  readonly endpoint: string;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  toJSON(): PushSubscriptionJSON;
}

/** One browser: at most one live subscription, a fresh endpoint on each new subscribe. */
function fakeBrowser(options: { noRegistration?: boolean } = {}) {
  let counter = 0;
  let unsubscribeResult: () => Promise<boolean> = async () => true;
  const state: { current: FakeSubscription | null } = { current: null };

  const makeSubscription = (): FakeSubscription => {
    counter += 1;
    const endpoint = `https://push.example/sub-${counter}`;
    const subscription: FakeSubscription = {
      endpoint,
      unsubscribe: vi.fn(async () => {
        const ok = await unsubscribeResult();
        if (ok && state.current === subscription) state.current = null;
        return ok;
      }),
      toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } })
    };
    return subscription;
  };

  const subscribe = vi.fn(async () => {
    state.current ??= makeSubscription();
    return state.current;
  });
  const registration = {
    pushManager: { getSubscription: vi.fn(async () => state.current), subscribe }
  };
  const container = {
    getRegistration: vi.fn(async () => (options.noRegistration ? undefined : registration)),
    ready: Promise.resolve(registration)
  } as unknown as PushServiceWorkerContainer;

  return {
    container,
    subscribe,
    state,
    subscribeNow: async () => subscribe(),
    failUnsubscribe(result: "false" | "reject") {
      unsubscribeResult =
        result === "false"
          ? async () => false
          : async () => {
              throw new Error("push service unreachable");
            };
    }
  };
}

/** The server's device table: upserts by endpoint fingerprint, like the real repository. */
function fakeServer() {
  const records = new Map<string, string>();
  let nextId = 1;
  let failDeletes = 0;

  const add = (endpoint: string): { id: string; endpointHash: string } => {
    const endpointHash = hashOf(endpoint);
    for (const [id, hash] of records) {
      if (hash === endpointHash) return { id, endpointHash };
    }
    const id = `device-${nextId++}`;
    records.set(id, endpointHash);
    return { id, endpointHash };
  };

  return {
    records,
    add,
    failNextDeletes(count: number) {
      failDeletes = count;
    },
    deleteOnServer: vi.fn(async (id: string) => {
      if (failDeletes > 0) {
        failDeletes -= 1;
        throw new Error("server down");
      }
      records.delete(id);
    }),
    registerOnServer: vi.fn(async (body: { endpoint: string }) => ({ device: add(body.endpoint) }))
  };
}

function memoryPending(): PendingRemovalStore & { ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    list: () => [...ids],
    add: (id) => {
      if (!ids.includes(id)) ids.push(id);
    },
    remove: (id) => {
      const index = ids.indexOf(id);
      if (index >= 0) ids.splice(index, 1);
    }
  };
}

const applicationServerKey = new Uint8Array([1, 2, 3]);

describe("removePushDevice", () => {
  it("unsubscribes this browser before deleting its record, matched by endpoint", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();
    const subscription = await browser.subscribeNow();
    const record = server.add(subscription.endpoint);
    const order: string[] = [];
    subscription.unsubscribe.mockImplementationOnce(async () => {
      order.push("unsubscribe");
      browser.state.current = null;
      return true;
    });
    server.deleteOnServer.mockImplementationOnce(async (id: string) => {
      order.push("delete");
      server.records.delete(id);
    });

    const outcome = await removePushDevice({
      device: record,
      container: browser.container,
      deleteOnServer: server.deleteOnServer,
      pending: memoryPending()
    });

    expect(order).toEqual(["unsubscribe", "delete"]);
    expect(outcome).toEqual({ removedThisDevice: true, browserStillSubscribed: false });
    expect(browser.state.current).toBeNull();
  });

  it("stale tab: removing an old record does not cancel this browser's newer subscription", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();

    // Tab A enabled, removed, and enabled again, so the browser now holds sub-2.
    const oldRecord = server.add((await browser.subscribeNow()).endpoint);
    browser.state.current = null;
    const newSubscription = await browser.subscribeNow();
    server.add(newSubscription.endpoint);

    // Tab B still lists the old record and removes it.
    const outcome = await removePushDevice({
      device: oldRecord,
      container: browser.container,
      deleteOnServer: server.deleteOnServer,
      pending: memoryPending()
    });

    expect(newSubscription.unsubscribe).not.toHaveBeenCalled();
    expect(browser.state.current).toBe(newSubscription);
    expect(server.deleteOnServer).toHaveBeenCalledWith(oldRecord.id);
    expect(outcome.removedThisDevice).toBe(false);
  });

  it("recognises this browser's record with no locally stored device id", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();
    const subscription = await browser.subscribeNow();
    const record = server.add(subscription.endpoint);

    const outcome = await removePushDevice({
      device: record,
      container: browser.container,
      deleteOnServer: server.deleteOnServer,
      pending: memoryPending()
    });

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(outcome.removedThisDevice).toBe(true);
  });

  it("only deletes the server record for another device", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();
    const subscription = await browser.subscribeNow();
    server.add(subscription.endpoint);
    const other = server.add("https://push.example/elsewhere");

    const outcome = await removePushDevice({
      device: other,
      container: browser.container,
      deleteOnServer: server.deleteOnServer,
      pending: memoryPending()
    });

    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(server.deleteOnServer).toHaveBeenCalledWith(other.id);
    expect(outcome).toEqual({ removedThisDevice: false, browserStillSubscribed: false });
  });

  it.each(["false", "reject"] as const)(
    "still deletes the record and reports it when unsubscribe gives %s",
    async (failure) => {
      const browser = fakeBrowser();
      const server = fakeServer();
      const record = server.add((await browser.subscribeNow()).endpoint);
      browser.failUnsubscribe(failure);
      const pending = memoryPending();

      const outcome = await removePushDevice({
        device: record,
        container: browser.container,
        deleteOnServer: server.deleteOnServer,
        pending
      });

      expect(server.deleteOnServer).toHaveBeenCalledWith(record.id);
      expect(outcome).toEqual({ removedThisDevice: true, browserStillSubscribed: true });
      expect(pending.ids).toEqual([]);
    }
  );

  it("deletes the record when there is no service worker", async () => {
    for (const container of [fakeBrowser({ noRegistration: true }).container, undefined]) {
      const server = fakeServer();
      const record = server.add("https://push.example/x");
      const outcome = await removePushDevice({
        device: record,
        container,
        deleteOnServer: server.deleteOnServer,
        pending: memoryPending()
      });
      expect(server.deleteOnServer).toHaveBeenCalledWith(record.id);
      expect(outcome).toEqual({ removedThisDevice: false, browserStillSubscribed: false });
    }
  });

  it("keeps a pending removal when the browser cancelled but the server delete failed", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();
    const record = server.add((await browser.subscribeNow()).endpoint);
    server.failNextDeletes(1);
    const pending = memoryPending();

    await expect(
      removePushDevice({
        device: record,
        container: browser.container,
        deleteOnServer: server.deleteOnServer,
        pending
      })
    ).rejects.toThrow("server down");

    expect(browser.state.current).toBeNull();
    expect(pending.ids).toEqual([record.id]);
  });
});

describe("enablePush after a partly failed removal", () => {
  it("finishes the pending removal before subscribing, leaving one record", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();
    const record = server.add((await browser.subscribeNow()).endpoint);
    const pending = memoryPending();
    server.failNextDeletes(1);
    await expect(
      removePushDevice({
        device: record,
        container: browser.container,
        deleteOnServer: server.deleteOnServer,
        pending
      })
    ).rejects.toThrow("server down");

    await enablePush({
      container: browser.container,
      applicationServerKey,
      registerOnServer: server.registerOnServer,
      deleteOnServer: server.deleteOnServer,
      pending
    });

    expect(server.records.size).toBe(1);
    expect(server.records.has(record.id)).toBe(false);
    expect(pending.ids).toEqual([]);
  });

  it("refuses to subscribe while the pending removal still cannot be finished", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();
    const record = server.add((await browser.subscribeNow()).endpoint);
    const pending = memoryPending();
    server.failNextDeletes(2);
    await expect(
      removePushDevice({
        device: record,
        container: browser.container,
        deleteOnServer: server.deleteOnServer,
        pending
      })
    ).rejects.toThrow("server down");
    browser.subscribe.mockClear();

    await expect(
      enablePush({
        container: browser.container,
        applicationServerKey,
        registerOnServer: server.registerOnServer,
        deleteOnServer: server.deleteOnServer,
        pending
      })
    ).rejects.toThrow(/finish removing/i);

    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(server.records.size).toBe(1);
    expect(pending.ids).toEqual([record.id]);
  });
});

describe("enablePush", () => {
  it("registers the new browser subscription with the server", async () => {
    const browser = fakeBrowser();
    const server = fakeServer();

    const result = await enablePush({
      container: browser.container,
      applicationServerKey,
      registerOnServer: server.registerOnServer,
      deleteOnServer: server.deleteOnServer,
      pending: memoryPending()
    });

    expect(server.registerOnServer).toHaveBeenCalledWith({
      endpoint: "https://push.example/sub-1",
      keys: { p256dh: "p256dh-key", auth: "auth-key" }
    });
    expect(result.device.endpointHash).toBe(hashOf("https://push.example/sub-1"));
  });

  it("unsubscribes a subscription it just created when the server rejects it", async () => {
    const browser = fakeBrowser();
    const rejected = new Error("device limit reached");

    await expect(
      enablePush({
        container: browser.container,
        applicationServerKey,
        registerOnServer: async () => {
          throw rejected;
        },
        deleteOnServer: async () => undefined,
        pending: memoryPending()
      })
    ).rejects.toBe(rejected);
    expect(browser.state.current).toBeNull();
  });

  it.each(["false", "reject"] as const)(
    "reports incomplete cleanup with a recovery message when unsubscribe gives %s",
    async (failure) => {
      const browser = fakeBrowser();
      browser.failUnsubscribe(failure);

      const error = await enablePush({
        container: browser.container,
        applicationServerKey,
        registerOnServer: async () => {
          throw new Error("device limit reached");
        },
        deleteOnServer: async () => undefined,
        pending: memoryPending()
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PushCleanupIncompleteError);
      expect((error as Error).message).toContain("device limit reached");
      expect((error as Error).message).toMatch(/browser settings/i);
    }
  );

  it("keeps a subscription that existed before enabling when the server rejects it", async () => {
    const browser = fakeBrowser();
    const existing = await browser.subscribeNow();

    await expect(
      enablePush({
        container: browser.container,
        applicationServerKey,
        registerOnServer: async () => {
          throw new Error("network");
        },
        deleteOnServer: async () => undefined,
        pending: memoryPending()
      })
    ).rejects.toThrow("network");
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it("fails clearly when no service worker is registered", async () => {
    await expect(
      enablePush({
        container: fakeBrowser({ noRegistration: true }).container,
        applicationServerKey,
        registerOnServer: fakeServer().registerOnServer,
        deleteOnServer: async () => undefined,
        pending: memoryPending()
      })
    ).rejects.toThrow(/reload the page/i);
  });
});

describe("notification settings push wiring", () => {
  it("routes Remove and Enable through the helpers and identifies this device by endpoint", () => {
    const view = readFileSync("apps/web/src/settings/settings-module-subviews.tsx", "utf8");

    expect(view).toContain("removePushDevice({");
    expect(view).toContain("enablePush({");
    expect(view).toContain("currentPushEndpointHash(");
    expect(view).not.toContain("moss.push.deviceId");
    expect(view).not.toContain("pushManager.subscribe(");
  });
});
