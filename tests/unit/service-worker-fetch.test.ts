import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SERVICE_WORKER_PATH = resolve(__dirname, "../../apps/web/public/service-worker.js");
const SERVICE_WORKER_SOURCE = readFileSync(SERVICE_WORKER_PATH, "utf8");

class FakeResponse {
  ok: boolean;
  status: number;
  type?: string;

  constructor(
    public body: unknown = null,
    init: { status?: number } = {}
  ) {
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
  }

  static error(): FakeResponse {
    const response = new FakeResponse(null, { status: 0 });
    response.type = "error";
    return response;
  }
}

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  destination: string;
}

function makeRequest(overrides: Partial<FakeRequest>): FakeRequest {
  return {
    url: "https://cdn.example.com/photo.jpg",
    method: "GET",
    mode: "same-origin",
    destination: "",
    ...overrides
  };
}

interface Sandbox {
  listeners: Record<string, Array<(event: unknown) => void>>;
  cacheStore: Map<string, FakeResponse>;
}

function loadServiceWorker(fetchImpl: (request: FakeRequest) => Promise<FakeResponse>): Sandbox {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const cacheStore = new Map<string, FakeResponse>();

  const self = {
    addEventListener(type: string, callback: (event: unknown) => void) {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(callback);
    },
    skipWaiting() {},
    clients: { claim: async () => {} }
  };

  const caches = {
    open: async () => ({
      put: async () => {},
      addAll: async () => {}
    }),
    match: async (request: FakeRequest | string) => {
      const key = typeof request === "string" ? request : request.url;
      return cacheStore.get(key);
    },
    keys: async () => [] as string[],
    delete: async () => true
  };

  const context = {
    self,
    caches,
    fetch: fetchImpl,
    Response: FakeResponse,
    URL,
    setTimeout,
    console
  };
  vm.createContext(context);
  vm.runInContext(SERVICE_WORKER_SOURCE, context);

  return { listeners, cacheStore };
}

function dispatchFetch(
  sandbox: Sandbox,
  request: FakeRequest
): Promise<FakeResponse> {
  let capturedPromise: Promise<FakeResponse> | undefined;
  const event = {
    request,
    respondWith(promise: Promise<FakeResponse>) {
      capturedPromise = promise;
    },
    waitUntil() {}
  };
  for (const listener of sandbox.listeners.fetch ?? []) {
    listener(event);
  }
  if (!capturedPromise) {
    throw new Error("fetch listener did not call respondWith");
  }
  return capturedPromise;
}

describe("service worker fetch recovery", () => {
  it("resolves (does not reject) an uncached cross-origin image GET whose fetch always rejects", async () => {
    let calls = 0;
    const sandbox = loadServiceWorker(async () => {
      calls += 1;
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    const request = makeRequest({
      url: "https://cdn.example.com/photo.jpg",
      destination: "image"
    });

    await expect(dispatchFetch(sandbox, request)).resolves.toBeInstanceOf(FakeResponse);
    expect(calls).toBeGreaterThan(0);
  }, 10_000);

  it("retries an uncached image GET after one rejection and resolves with the successful response", async () => {
    let calls = 0;
    const success = new FakeResponse("image bytes", { status: 200 });
    const sandbox = loadServiceWorker(async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("NetworkError when attempting to fetch resource.");
      }
      return success;
    });

    const request = makeRequest({
      url: "https://cdn.example.com/logo.png",
      destination: "image"
    });

    const response = await dispatchFetch(sandbox, request);
    expect(response).toBe(success);
    expect(calls).toBeGreaterThan(1);
  }, 10_000);

  it("resolves (does not reject) an uncached same-origin GET whose fetch rejects", async () => {
    const sandbox = loadServiceWorker(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    const request = makeRequest({
      url: "https://app.example.com/data.json",
      destination: ""
    });

    await expect(dispatchFetch(sandbox, request)).resolves.toBeInstanceOf(FakeResponse);
  });

  it("serves a cached request from cache without calling fetch", async () => {
    let calls = 0;
    const sandbox = loadServiceWorker(async () => {
      calls += 1;
      throw new Error("network fetch should not be called for a cache hit");
    });

    const cached = new FakeResponse("cached bytes", { status: 200 });
    sandbox.cacheStore.set("https://app.example.com/shell.js", cached);

    const request = makeRequest({
      url: "https://app.example.com/shell.js",
      destination: "script"
    });

    const response = await dispatchFetch(sandbox, request);
    expect(response).toBe(cached);
    expect(calls).toBe(0);
  });

  it("falls back to the cached offline page for a navigate request whose fetch rejects", async () => {
    const sandbox = loadServiceWorker(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    const offline = new FakeResponse("<html>offline</html>", { status: 200 });
    sandbox.cacheStore.set("/offline.html", offline);

    const request = makeRequest({
      url: "https://app.example.com/some-page",
      mode: "navigate",
      destination: "document"
    });

    const response = await dispatchFetch(sandbox, request);
    expect(response).toBe(offline);
  });
});
