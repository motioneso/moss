import type { RegisterPushSubscriptionRequest } from "@moss/shared";

// #2308: the browser's push subscription and the server's device record move together.
// Removing this browser's device calls PushSubscription.unsubscribe() before deleting the
// server record, and a subscription created by a failed enable is unsubscribed again.

interface BrowserPushSubscription {
  unsubscribe(): Promise<boolean>;
  toJSON(): PushSubscriptionJSON;
}

interface BrowserPushRegistration {
  readonly pushManager: {
    getSubscription(): Promise<BrowserPushSubscription | null>;
    subscribe(options: PushSubscriptionOptionsInit): Promise<BrowserPushSubscription>;
  };
}

/** The slice of `navigator.serviceWorker` push needs; injected so tests can fake it. */
export interface PushServiceWorkerContainer {
  getRegistration(): Promise<BrowserPushRegistration | undefined>;
  readonly ready: Promise<BrowserPushRegistration>;
}

export function browserPushContainer(): PushServiceWorkerContainer | undefined {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return undefined;
  }
  return navigator.serviceWorker;
}

export interface RemovePushDeviceOutcome {
  readonly removedThisDevice: boolean;

  /** True when this browser's own subscription could not be unsubscribed. */
  readonly browserStillSubscribed: boolean;
}

/**
 * Only this browser's own subscription can be unsubscribed here; another device's record is
 * deleted on the server alone. An unsubscribe failure does not block the server delete,
 * because the delete is what stops Moss sending to the device.
 */
export async function removePushDevice(input: {
  readonly deviceId: string;
  readonly currentDeviceId: string | null;
  readonly container: PushServiceWorkerContainer | undefined;
  readonly deleteOnServer: (deviceId: string) => Promise<unknown>;
}): Promise<RemovePushDeviceOutcome> {
  const removedThisDevice = input.deviceId === input.currentDeviceId;
  let browserStillSubscribed = false;

  if (removedThisDevice && input.container) {
    browserStillSubscribed = !(await unsubscribeCurrent(input.container));
  }

  await input.deleteOnServer(input.deviceId);
  return { removedThisDevice, browserStillSubscribed };
}

/** Resolves true when no subscription remains in this browser. */
async function unsubscribeCurrent(container: PushServiceWorkerContainer): Promise<boolean> {
  try {
    const registration = await container.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) {
      return true;
    }
    return await subscription.unsubscribe();
  } catch {
    return false;
  }
}

/**
 * Subscribes this browser and registers it with the server. If the server rejects it, a
 * subscription created by this call is unsubscribed again; one that already existed is kept,
 * because the server may still hold a working record for it.
 */
export async function registerBrowserPush<T>(input: {
  readonly container: PushServiceWorkerContainer | undefined;
  readonly applicationServerKey: BufferSource;
  readonly registerOnServer: (body: RegisterPushSubscriptionRequest) => Promise<T>;
}): Promise<T> {
  const registration = input.container ? await input.container.getRegistration() : undefined;
  if (!input.container || !registration) {
    throw new Error("Push isn't ready on this page yet. Reload the page and try again.");
  }

  const active = await input.container.ready;
  const existing = await active.pushManager.getSubscription();
  const subscription = await active.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: input.applicationServerKey
  });

  try {
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error("The browser didn't return a usable subscription.");
    }
    return await input.registerOnServer({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
    });
  } catch (err) {
    if (!existing) {
      await subscription.unsubscribe().catch(() => false);
    }
    throw err;
  }
}
