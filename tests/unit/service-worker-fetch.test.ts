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
  matchCalls: number;
}

function loadServiceWorker(
  fetchImpl: (request: FakeRequest) => Promise<FakeResponse>,
  options: { matchRejects?: boolean } = {}
): Sandbox {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const cacheStore = new Map<string, FakeResponse>();
  const sandbox: Sandbox = { listeners, cacheStore, matchCalls: 0 };

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
      sandbox.matchCalls += 1;
      if (options.matchRejects) {
        throw new Error("cache storage unavailable");
      }
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

  return sandbox;
}

function dispatchFetch(sandbox: Sandbox, request: FakeRequest): Promise<FakeResponse> {
  const captured = tryDispatchFetch(sandbox, request);
  if (!captured) {
    throw new Error("fetch listener did not call respondWith");
  }
  return captured;
}

// Returns undefined when the worker declines to handle the request (no respondWith() call),
// which is the expected, correct behavior for API and non-GET requests — the browser must
// handle those natively. `dispatchFetch` throws on this case; use this instead to assert it.
function tryDispatchFetch(
  sandbox: Sandbox,
  request: FakeRequest
): Promise<FakeResponse> | undefined {
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

  it("makes exactly three attempts for an image GET that always rejects, then stops", async () => {
    let calls = 0;
    const sandbox = loadServiceWorker(async () => {
      calls += 1;
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    const request = makeRequest({
      url: "https://cdn.example.com/always-broken.jpg",
      destination: "image"
    });

    await dispatchFetch(sandbox, request);
    // One initial attempt plus the two documented retry delays (250ms, 1000ms) — not
    // "more than one", which would also pass an accidental unlimited-retry regression.
    expect(calls).toBe(3);
  }, 10_000);

  it("makes exactly one attempt for a non-image uncached GET that rejects — no image retry budget", async () => {
    let calls = 0;
    const sandbox = loadServiceWorker(async () => {
      calls += 1;
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    const request = makeRequest({
      url: "https://app.example.com/data.json",
      destination: ""
    });

    await dispatchFetch(sandbox, request);
    expect(calls).toBe(1);
  });

  it("resolves an unrecoverable image failure with a genuine network-error response, not a fabricated success", async () => {
    const sandbox = loadServiceWorker(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });

    const request = makeRequest({
      url: "https://cdn.example.com/always-broken.jpg",
      destination: "image"
    });

    const response = await dispatchFetch(sandbox, request);
    // A response with ok:true and no `type` would satisfy "resolves to a Response", which is
    // all the earlier tests check — this pins that it's specifically Response.error().
    expect(response.type).toBe("error");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(0);
  }, 10_000);

  it("does not intercept requests to /api/ paths — no respondWith, no cache read", async () => {
    const sandbox = loadServiceWorker(async () => {
      throw new Error("network fetch should not be called for an API request");
    });

    const request = makeRequest({
      url: "https://app.example.com/api/notes/123",
      method: "GET",
      destination: ""
    });

    const captured = tryDispatchFetch(sandbox, request);
    expect(captured).toBeUndefined();
    // The highest-value case here: the worker must not even look in the cache for an API
    // response. Every cache the site owns is searched by a bare caches.match(), and API
    // responses carry the signed-in user's private data.
    expect(sandbox.matchCalls).toBe(0);
  });

  it("does not intercept non-GET requests", async () => {
    const sandbox = loadServiceWorker(async () => {
      throw new Error("network fetch should not be called for a non-GET request");
    });

    const request = makeRequest({
      url: "https://app.example.com/some-resource",
      method: "POST",
      destination: ""
    });

    const captured = tryDispatchFetch(sandbox, request);
    expect(captured).toBeUndefined();
    expect(sandbox.matchCalls).toBe(0);
  });

  it("falls through to a network fetch when the cache lookup itself rejects, instead of rejecting respondWith", async () => {
    let calls = 0;
    const success = new FakeResponse("bytes", { status: 200 });
    const sandbox = loadServiceWorker(
      async () => {
        calls += 1;
        return success;
      },
      { matchRejects: true }
    );

    const request = makeRequest({
      url: "https://app.example.com/data.json",
      destination: ""
    });

    await expect(dispatchFetch(sandbox, request)).resolves.toBe(success);
    expect(calls).toBe(1);
  });
});
