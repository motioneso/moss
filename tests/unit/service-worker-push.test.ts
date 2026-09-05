import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SERVICE_WORKER_PATH = resolve(__dirname, "../../apps/web/public/service-worker.js");
const SERVICE_WORKER_SOURCE = readFileSync(SERVICE_WORKER_PATH, "utf8");

const APP_ORIGIN = "https://app.example.test";

interface FakeWindowClient {
  url: string;
  focused: string[];
  navigated: string[];
  focus(): Promise<FakeWindowClient>;
  navigate(url: string): Promise<FakeWindowClient>;
}

interface Sandbox {
  listeners: Record<string, Array<(event: unknown) => void>>;
  openedWindows: string[];
  shown: Array<{ title: string; options: Record<string, unknown> }>;
  windows: FakeWindowClient[];
}

// Same sandbox shape as service-worker-fetch.test.ts, plus the pieces the push and click
// handlers touch: self.location, self.registration, clients.matchAll and clients.openWindow.
function loadServiceWorker(windows: FakeWindowClient[] = []): Sandbox {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const sandbox: Sandbox = { listeners, openedWindows: [], shown: [], windows };

  const self = {
    addEventListener(type: string, callback: (event: unknown) => void) {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(callback);
    },
    skipWaiting() {},
    location: { origin: APP_ORIGIN, href: `${APP_ORIGIN}/service-worker.js` },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        sandbox.shown.push({ title, options });
      }
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        sandbox.openedWindows.push(url);
        return null;
      }
    }
  };

  const caches = {
    open: async () => ({ put: async () => {}, addAll: async () => {} }),
    match: async () => undefined,
    keys: async () => [] as string[],
    delete: async () => true
  };

  const context = {
    self,
    caches,
    fetch: async () => {
      throw new Error("fetch not expected");
    },
    Response: class {},
    URL,
    setTimeout,
    console
  };
  vm.createContext(context);
  vm.runInContext(SERVICE_WORKER_SOURCE, context);

  return sandbox;
}

function fakeWindow(url: string): FakeWindowClient {
  const client: FakeWindowClient = {
    url,
    focused: [],
    navigated: [],
    async focus() {
      client.focused.push(client.url);
      return client;
    },
    async navigate(target: string) {
      client.navigated.push(target);
      client.url = target;
      return client;
    }
  };
  return client;
}

async function click(sandbox: Sandbox, href: unknown): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const event = {
    notification: { close() {}, data: { href } },
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    }
  };
  for (const listener of sandbox.listeners.notificationclick ?? []) {
    listener(event);
  }
  await Promise.all(pending);
}

describe("service worker notificationclick (#743 security finding 4)", () => {
  it("opens a same-origin path on the app's own origin", async () => {
    const sandbox = loadServiceWorker();
    await click(sandbox, "/tasks/1?tab=notes");
    expect(sandbox.openedWindows).toEqual([`${APP_ORIGIN}/tasks/1?tab=notes`]);
  });

  it.each([
    ["backslash after slash", "/\\evil.example.com/x"],
    ["absolute outside URL", "https://evil.example.com/x"],
    ["protocol-relative", "//evil.example.com/x"],
    ["scheme", "javascript:alert(1)"],
    ["not a string", 42],
    ["missing", undefined],
    ["null", null]
  ])("opens the home page instead of a foreign target: %s", async (_label, href) => {
    const sandbox = loadServiceWorker();
    await click(sandbox, href);
    expect(sandbox.openedWindows).toEqual([`${APP_ORIGIN}/`]);
  });

  it("focuses an already-open window on the target instead of opening another", async () => {
    const existing = fakeWindow(`${APP_ORIGIN}/tasks/1`);
    const sandbox = loadServiceWorker([existing]);
    await click(sandbox, "/tasks/1");
    expect(existing.focused).toEqual([`${APP_ORIGIN}/tasks/1`]);
    expect(sandbox.openedWindows).toEqual([]);
  });

  it("never navigates an open window to a foreign origin", async () => {
    const existing = fakeWindow(`${APP_ORIGIN}/today`);
    const sandbox = loadServiceWorker([existing]);
    await click(sandbox, "/\\evil.example.com");
    expect(existing.navigated).toEqual([`${APP_ORIGIN}/`]);
    expect(sandbox.openedWindows).toEqual([]);
  });
});

describe("service worker push (#743)", () => {
  it("shows the payload's title, body and href only", async () => {
    const sandbox = loadServiceWorker();
    const pending: Promise<unknown>[] = [];
    const event = {
      data: { json: () => ({ id: "n1", title: "Hi", body: "there", href: "/tasks/1", extra: 1 }) },
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      }
    };
    for (const listener of sandbox.listeners.push ?? []) {
      listener(event);
    }
    await Promise.all(pending);
    expect(sandbox.shown).toEqual([
      { title: "Hi", options: { body: "there", icon: "/icons/icon.svg", data: { href: "/tasks/1" } } }
    ]);
  });
});
