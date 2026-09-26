import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  registerBrowserPush,
  removePushDevice,
  type PushServiceWorkerContainer
} from "../../apps/web/src/settings/push-browser-subscription.js";

// #2308: removing this browser's device must also unsubscribe the browser's own push
// subscription, so no live registration lingers with the push service.

interface FakeSubscription {
  readonly endpoint: string;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  toJSON(): PushSubscriptionJSON;
}

function fakeSubscription(
  options: { unsubscribe?: () => Promise<boolean> } = {}
): FakeSubscription {
  return {
    endpoint: "https://push.example/abc",
    unsubscribe: vi.fn(options.unsubscribe ?? (async () => true)),
    toJSON: () => ({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-key" }
    })
  };
}

function fakeContainer(options: {
  existing?: FakeSubscription | null;
  created?: FakeSubscription;
  noRegistration?: boolean;
}): PushServiceWorkerContainer & { subscribe: ReturnType<typeof vi.fn> } {
  const subscribe = vi.fn(async () => options.created ?? fakeSubscription());
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => options.existing ?? null),
      subscribe
    }
  };
  return {
    getRegistration: vi.fn(async () => (options.noRegistration ? undefined : registration)),
    ready: Promise.resolve(registration),
    subscribe
  } as unknown as PushServiceWorkerContainer & { subscribe: ReturnType<typeof vi.fn> };
}

describe("removePushDevice", () => {
  it("unsubscribes the browser before deleting the server record when removing this device", async () => {
    const subscription = fakeSubscription();
    const order: string[] = [];
    subscription.unsubscribe.mockImplementation(async () => {
      order.push("unsubscribe");
      return true;
    });
    const deleteOnServer = vi.fn(async () => {
      order.push("delete");
    });

    const outcome = await removePushDevice({
      deviceId: "device-1",
      currentDeviceId: "device-1",
      container: fakeContainer({ existing: subscription }),
      deleteOnServer
    });

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(deleteOnServer).toHaveBeenCalledWith("device-1");
    expect(order).toEqual(["unsubscribe", "delete"]);
    expect(outcome).toEqual({ removedThisDevice: true, browserStillSubscribed: false });
  });

  it("only deletes the server record when removing a different device", async () => {
    const subscription = fakeSubscription();
    const deleteOnServer = vi.fn(async () => undefined);

    const outcome = await removePushDevice({
      deviceId: "device-2",
      currentDeviceId: "device-1",
      container: fakeContainer({ existing: subscription }),
      deleteOnServer
    });

    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(deleteOnServer).toHaveBeenCalledWith("device-2");
    expect(outcome).toEqual({ removedThisDevice: false, browserStillSubscribed: false });
  });

  it("still deletes the server record and reports it when the browser refuses to unsubscribe", async () => {
    const subscription = fakeSubscription({
      unsubscribe: async () => {
        throw new Error("push service unreachable");
      }
    });
    const deleteOnServer = vi.fn(async () => undefined);

    const outcome = await removePushDevice({
      deviceId: "device-1",
      currentDeviceId: "device-1",
      container: fakeContainer({ existing: subscription }),
      deleteOnServer
    });

    expect(deleteOnServer).toHaveBeenCalledWith("device-1");
    expect(outcome).toEqual({ removedThisDevice: true, browserStillSubscribed: true });
  });

  it("treats an unsubscribe that resolves false as still subscribed", async () => {
    const subscription = fakeSubscription({ unsubscribe: async () => false });

    const outcome = await removePushDevice({
      deviceId: "device-1",
      currentDeviceId: "device-1",
      container: fakeContainer({ existing: subscription }),
      deleteOnServer: async () => undefined
    });

    expect(outcome.browserStillSubscribed).toBe(true);
  });

  it("deletes the server record when there is no service worker or no browser subscription", async () => {
    for (const container of [
      fakeContainer({ noRegistration: true }),
      fakeContainer({ existing: null }),
      undefined
    ]) {
      const deleteOnServer = vi.fn(async () => undefined);
      const outcome = await removePushDevice({
        deviceId: "device-1",
        currentDeviceId: "device-1",
        container,
        deleteOnServer
      });
      expect(deleteOnServer).toHaveBeenCalledWith("device-1");
      expect(outcome).toEqual({ removedThisDevice: true, browserStillSubscribed: false });
    }
  });

  it("propagates a server delete failure after unsubscribing, so the user can retry", async () => {
    const subscription = fakeSubscription();

    await expect(
      removePushDevice({
        deviceId: "device-1",
        currentDeviceId: "device-1",
        container: fakeContainer({ existing: subscription }),
        deleteOnServer: async () => {
          throw new Error("server down");
        }
      })
    ).rejects.toThrow("server down");
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("registerBrowserPush", () => {
  const applicationServerKey = new Uint8Array([1, 2, 3]);

  it("registers the new browser subscription with the server", async () => {
    const container = fakeContainer({ existing: null });
    const registerOnServer = vi.fn(async () => ({ deviceId: "device-9" }));

    const result = await registerBrowserPush({ container, applicationServerKey, registerOnServer });

    expect(registerOnServer).toHaveBeenCalledWith({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p256dh-key", auth: "auth-key" }
    });
    expect(result).toEqual({ deviceId: "device-9" });
  });

  it("unsubscribes a subscription it just created when the server rejects it", async () => {
    const created = fakeSubscription();
    const container = fakeContainer({ existing: null, created });

    await expect(
      registerBrowserPush({
        container,
        applicationServerKey,
        registerOnServer: async () => {
          throw new Error("device limit reached");
        }
      })
    ).rejects.toThrow("device limit reached");
    expect(created.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a subscription that existed before enabling when the server rejects the re-registration", async () => {
    const existing = fakeSubscription();
    const container = fakeContainer({ existing, created: existing });

    await expect(
      registerBrowserPush({
        container,
        applicationServerKey,
        registerOnServer: async () => {
          throw new Error("network");
        }
      })
    ).rejects.toThrow("network");
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it("fails clearly when no service worker is registered", async () => {
    await expect(
      registerBrowserPush({
        container: fakeContainer({ noRegistration: true }),
        applicationServerKey,
        registerOnServer: async () => ({ deviceId: "x" })
      })
    ).rejects.toThrow(/reload the page/i);
  });
});

describe("notification settings push wiring", () => {
  it("routes Remove and Enable through the helpers that keep the browser in step", () => {
    const view = readFileSync("apps/web/src/settings/settings-module-subviews.tsx", "utf8");

    expect(view).toContain("removePushDevice({");
    expect(view).toContain("registerBrowserPush({");
    expect(view).not.toContain("mutationFn: (device: PushDeviceDto) => deletePushSubscription(");
    expect(view).not.toContain("pushManager.subscribe(");
  });
});
