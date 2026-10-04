import type { RegisterPushSubscriptionRequest } from "@moss/shared";
import { assistantName } from "../api/use-assistant-name.js";

// #2308: keep this browser's push subscription and the server's device records in step.
// "This device" is the record whose endpoint fingerprint matches the subscription the
// browser holds right now, so a stale tab or a cleared cache cannot pick the wrong one.

interface BrowserPushSubscription {
  readonly endpoint: string;
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

/**
 * Device ids whose browser subscription was cancelled but whose server record could not be
 * deleted yet. Enabling again must finish these first, or the old record would sit beside
 * the new one.
 */
export interface PendingRemovalStore {
  list(): string[];
  add(id: string): void;
  remove(id: string): void;
}

interface PushDeviceRef {
  readonly id: string;
  readonly endpointHash: string;
}

/** The slice of `navigator.locks` used to run push changes one at a time across tabs. */
export interface PushLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface PushLock {
  run<T>(task: () => Promise<T>): Promise<T>;
}

const PUSH_LOCK_NAME = "moss.push.device";

/**
 * Runs Enable and Remove one at a time. Tasks queue within the page, and each also holds a
 * Web Lock when the browser has one, so other tabs of this site wait too. Without Web Locks
 * only this page is serialized.
 */
export function createPushLock(locks: PushLockManager | undefined): PushLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const start = () => (locks ? locks.request(PUSH_LOCK_NAME, task) : task());
      const result = tail.then(start, start);
      tail = result.catch(() => undefined);
      return result;
    }
  };
}

let pageLock: PushLock | undefined;

function defaultPushLock(): PushLock {
  pageLock ??= createPushLock(
    typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined
  );
  return pageLock;
}

export class PushCleanupIncompleteError extends Error {
  constructor(cause: unknown) {
    const reason = (cause instanceof Error ? cause.message : String(cause)).replace(/[.\s]*$/, ".");
    super(
      `${reason} This browser kept the push registration it had just made, and ${assistantName()} may ` +
        "or may not have saved it. Try again to finish turning push on, or clear it in this " +
        "site's browser settings and remove any extra device listed here."
    );
    this.name = "PushCleanupIncompleteError";
  }
}

export function browserPushContainer(): PushServiceWorkerContainer | undefined {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return undefined;
  }
  return navigator.serviceWorker;
}

/** sha256 hex of the endpoint URL, the same fingerprint the server stores. */
export async function hashPushEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function currentSubscription(
  container: PushServiceWorkerContainer | undefined
): Promise<BrowserPushSubscription | null> {
  const registration = await container?.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Fingerprint of the subscription this browser holds now, or null when it holds none. */
export async function currentPushEndpointHash(
  container: PushServiceWorkerContainer | undefined
): Promise<string | null> {
  const subscription = await currentSubscription(container).catch(() => null);
  return subscription ? hashPushEndpoint(subscription.endpoint) : null;
}

/** Resolves true only when the browser confirms the subscription is gone. */
async function tryUnsubscribe(subscription: BrowserPushSubscription): Promise<boolean> {
  try {
    return await subscription.unsubscribe();
  } catch {
    return false;
  }
}

export interface RemovePushDeviceOutcome {
  readonly removedThisDevice: boolean;

  /** True when this browser's own subscription could not be unsubscribed. */
  readonly browserStillSubscribed: boolean;
}

/**
 * Removes one device record. When the record is this browser's current subscription, the
 * subscription is unsubscribed first; another device's record is deleted on the server alone.
 * An unsubscribe failure does not block the delete, because the delete is what stops Moss
 * sending to the device.
 */
export async function removePushDevice(input: {
  readonly device: PushDeviceRef;
  readonly container: PushServiceWorkerContainer | undefined;
  readonly deleteOnServer: (deviceId: string) => Promise<unknown>;
  readonly pending: PendingRemovalStore;
  readonly lock?: PushLock;
}): Promise<RemovePushDeviceOutcome> {
  return (input.lock ?? defaultPushLock()).run(() => removeUnlocked(input));
}

async function removeUnlocked(input: {
  readonly device: PushDeviceRef;
  readonly container: PushServiceWorkerContainer | undefined;
  readonly deleteOnServer: (deviceId: string) => Promise<unknown>;
  readonly pending: PendingRemovalStore;
}): Promise<RemovePushDeviceOutcome> {
  const subscription = await currentSubscription(input.container).catch(() => null);
  const removedThisDevice =
    subscription !== null &&
    (await hashPushEndpoint(subscription.endpoint)) === input.device.endpointHash;

  let browserStillSubscribed = false;
  if (subscription && removedThisDevice) {
    input.pending.add(input.device.id);
    browserStillSubscribed = !(await tryUnsubscribe(subscription));
    if (browserStillSubscribed) {
      // Same endpoint stays in the browser, so a later enable updates this record in place.
      input.pending.remove(input.device.id);
    }
  }

  await input.deleteOnServer(input.device.id);
  input.pending.remove(input.device.id);
  return { removedThisDevice, browserStillSubscribed };
}

/**
 * Finishes removals left pending, then subscribes this browser and registers it. If the
 * server rejects the registration, a subscription created by this call is unsubscribed; one
 * that already existed is kept, because the server may still hold a working record for it.
 */
export async function enablePush<T>(input: {
  readonly container: PushServiceWorkerContainer | undefined;
  readonly applicationServerKey: BufferSource;
  readonly registerOnServer: (body: RegisterPushSubscriptionRequest) => Promise<T>;
  readonly deleteOnServer: (deviceId: string) => Promise<unknown>;
  readonly pending: PendingRemovalStore;
  readonly lock?: PushLock;
}): Promise<T> {
  return (input.lock ?? defaultPushLock()).run(() => enableUnlocked(input));
}

async function enableUnlocked<T>(input: {
  readonly container: PushServiceWorkerContainer | undefined;
  readonly applicationServerKey: BufferSource;
  readonly registerOnServer: (body: RegisterPushSubscriptionRequest) => Promise<T>;
  readonly deleteOnServer: (deviceId: string) => Promise<unknown>;
  readonly pending: PendingRemovalStore;
}): Promise<T> {
  for (const id of input.pending.list()) {
    try {
      await input.deleteOnServer(id);
    } catch {
      throw new Error(
        "Couldn't finish removing this device's old registration, so push was not turned on. Try again."
      );
    }
    input.pending.remove(id);
  }

  const registration = await input.container?.getRegistration();
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
    if (!existing && !(await tryUnsubscribe(subscription))) {
      throw new PushCleanupIncompleteError(err);
    }
    throw err;
  }
}
