import { brotliCompressSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createHostPinnedFetch } from "../../packages/host-fetch/src/index.js";

describe("host-pinned fetch transport", () => {
  it("connects to the validated public address while forcing hostname SNI and Host", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (request) => {
        requests.push(request as unknown as Record<string, unknown>);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from("{}");
          })()
        };
      }
    });

    const response = await fetchFn("https://api.example.com/data");

    expect(response.status).toBe(200);
    expect(requests).toEqual([
      expect.objectContaining({
        address: "93.184.216.34",
        servername: "api.example.com",
        host: "api.example.com",
        path: "/data"
      })
    ]);
  });

  // The hex-form v4-mapped case below is parity/coverage, not a regression test: Node's
  // net.BlockList already normalizes hex-form v4-mapped IPv6 (e.g. ::ffff:a9fe:a9fe) against
  // ipv4 subnet rules before this change (verified empirically on v22.22.2 and v24.19.0 — the
  // pre-fix isBlocked() already rejected all three addresses this it.each table targets via
  // BLOCKED.check's own normalization). isBlocked()'s explicit hex-form normalization added in
  // #946 makes that behavior independent of BlockList's implicit engine-version handling rather
  // than closing a reachable gap.
  it.each([
    ["private IPv4", "10.0.0.1", 4],
    ["deprecated 6to4 relay", "192.88.99.1", 4],
    ["multicast IPv4", "224.0.0.1", 4],
    ["ORCHIDv1 IPv6", "2001:10::1", 6],
    ["unique-local IPv6", "fd00::1", 6],
    ["multicast IPv6", "ff02::1", 6],
    ["hex-form v4-mapped IPv6 (metadata endpoint)", "::ffff:a9fe:a9fe", 6]
  ] as const)("rejects %s DNS answers", async (_name, address, family) => {
    let requested = false;
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      resolve: async () => [{ address, family }],
      request: async () => {
        requested = true;
        throw new Error("must not connect");
      }
    });

    await expect(fetchFn("https://api.example.com/data")).rejects.toMatchObject({
      code: "blocked_address"
    });
    expect(requested).toBe(false);
  });

  it("enforces one deadline across DNS resolution", async () => {
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      timeoutMs: 5,
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [{ address: "93.184.216.34", family: 4 }];
      },
      request: async () => ({
        status: 200,
        headers: {},
        body: (async function* () {})()
      })
    });

    await expect(fetchFn("https://api.example.com/data")).rejects.toMatchObject({
      code: "fetch_timeout"
    });
  });

  it("preserves bodyless 204 responses", async () => {
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => ({
        status: 204,
        headers: {},
        body: (async function* () {})()
      })
    });

    await expect(fetchFn("https://api.example.com/data")).resolves.toMatchObject({ status: 204 });
  });

  // Regression: this transport is typed `typeof fetch` but builds a raw https.request, so it sent
  // none of the headers undici adds for free. Bot-mitigation edges score that shape as non-browser
  // and reject it — ESPN/Akamai 403'd every pinned request on 2026-08-05, and because
  // datasets/client.ts swallows fetch errors the whole sports module silently served empty
  // fallbacks with no log line. All three headers are required together; each alone still 403s.
  describe("default request headers", () => {
    const capture = () => {
      const requests: Array<Record<string, unknown>> = [];
      const fetchFn = createHostPinnedFetch(["api.example.com"], {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async (request) => {
          requests.push(request as unknown as Record<string, unknown>);
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: (async function* () {
              yield Buffer.from("{}");
            })()
          };
        }
      });
      return { requests, fetchFn };
    };

    it("sends accept, user-agent and accept-encoding on every request", async () => {
      const { requests, fetchFn } = capture();

      await fetchFn("https://api.example.com/data");

      const headers = requests[0]!.headers as Record<string, string>;
      expect(headers.accept).toBe("*/*");
      expect(headers["accept-encoding"]).toBe("gzip, deflate, br");
      // Must carry a Product/Version token: a bare "jarv1s-host-fetch" is rejected where
      // "Jarv1s/1.0 (+url)" is accepted, so the version is load-bearing, not decoration.
      expect(headers["user-agent"]).toMatch(/^\S+\/\d+\.\d+/);
    });

    it("lets a caller's own header win over the default", async () => {
      const { requests, fetchFn } = capture();

      await fetchFn("https://api.example.com/data", { headers: { accept: "application/json" } });

      expect((requests[0]!.headers as Record<string, string>).accept).toBe("application/json");
    });
  });

  describe("content-encoding", () => {
    const respondWith = (body: Buffer, encoding: string) =>
      createHostPinnedFetch(["api.example.com"], {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async () => ({
          status: 200,
          headers: { "content-type": "application/json", "content-encoding": encoding },
          body: (async function* () {
            yield body;
          })()
        })
      });

    // We advertise accept-encoding, so we must decode what comes back. Handing the caller
    // compressed bytes would break every response.json() — the two halves ship together.
    it("decodes a gzip body and drops the headers describing the wire form", async () => {
      const fetchFn = respondWith(gzipSync(Buffer.from('{"ok":true}')), "gzip");

      const response = await fetchFn("https://api.example.com/data");

      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(response.headers.get("content-encoding")).toBeNull();
    });

    it("decodes a brotli body", async () => {
      const fetchFn = respondWith(brotliCompressSync(Buffer.from('{"ok":true}')), "br");

      await expect((await fetchFn("https://api.example.com/data")).json()).resolves.toEqual({
        ok: true
      });
    });

    // The streaming cap upstream only ever measures compressed bytes, so the decompressed size
    // needs its own limit or a small gzip bomb expands straight past what the caller asked for.
    it("enforces the response cap against the decompressed size", async () => {
      const fetchFn = createHostPinnedFetch(["api.example.com"], {
        maxResponseBytes: 1024,
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async () => ({
          status: 200,
          headers: { "content-encoding": "gzip" },
          body: (async function* () {
            yield gzipSync(Buffer.alloc(1024 * 1024, "a"));
          })()
        })
      });

      await expect(fetchFn("https://api.example.com/data")).rejects.toThrow(/response_too_large/);
    });
  });

  it("rejects a non-443 port before any DNS resolution or request", async () => {
    let resolved = false;
    let requested = false;
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      resolve: async () => {
        resolved = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      request: async () => {
        requested = true;
        throw new Error("must not connect");
      }
    });

    await expect(fetchFn("https://api.example.com:8443/data")).rejects.toMatchObject({
      code: "invalid_request"
    });
    expect(resolved).toBe(false);
    expect(requested).toBe(false);
  });

  it("rejects userinfo embedded in the URL", async () => {
    let requested = false;
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => {
        requested = true;
        throw new Error("must not connect");
      }
    });

    await expect(fetchFn("https://user:pass@api.example.com/data")).rejects.toMatchObject({
      code: "invalid_request"
    });
    expect(requested).toBe(false);
  });

  it("aborts an unencoded stream mid-flight once it exceeds the response cap", async () => {
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      maxResponseBytes: 16,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => ({
        status: 200,
        headers: {},
        body: (async function* () {
          for (let i = 0; i < 100; i += 1) {
            yield Buffer.alloc(8, "a");
          }
        })()
      })
    });

    await expect(fetchFn("https://api.example.com/data")).rejects.toMatchObject({
      code: "response_too_large"
    });
  });

  it("wipes caller headers on a cross-origin redirect, and never leaks them on a same-host port change", async () => {
    const crossHostRequests: Array<Record<string, unknown>> = [];
    const crossHostFetch = createHostPinnedFetch(["api.example.com", "other.example.com"], {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (request) => {
        crossHostRequests.push(request as unknown as Record<string, unknown>);
        if (crossHostRequests.length === 1) {
          return {
            status: 302,
            headers: { location: "https://other.example.com/data" } as Record<string, string>,
            body: (async function* () {})()
          };
        }
        return {
          status: 200,
          headers: {} as Record<string, string>,
          body: (async function* () {
            yield Buffer.from("{}");
          })()
        };
      }
    });
    await crossHostFetch("https://api.example.com/data", {
      headers: { authorization: "Bearer secret" }
    });
    expect(crossHostRequests).toHaveLength(2);
    expect(crossHostRequests[1]!.headers).not.toHaveProperty("authorization");

    // A same-host redirect to a non-443 port can never reach a second request() call at all —
    // validateUrl rejects the nonstandard port on the next hop before any headers could be sent,
    // so the header-wipe path is unreachable for this shape rather than leaking anything.
    let samePortHostRequests = 0;
    const samePortFetch = createHostPinnedFetch(["api.example.com"], {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => {
        samePortHostRequests += 1;
        return {
          status: 302,
          headers: { location: "https://api.example.com:8443/data" },
          body: (async function* () {})()
        };
      }
    });
    await expect(
      samePortFetch("https://api.example.com/data", { headers: { authorization: "Bearer secret" } })
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(samePortHostRequests).toBe(1);
  });

  // Knock-out verified (PR #1654 QA follow-up, 2026-08-17): scratch-guarding the isBlocked()
  // check with `hop === 0` so it only runs on the first hop turns this test red (rejects with
  // "invalid_request" via the redirect-loop's own bookkeeping, not "blocked_address" — proving
  // the assertion below depends on the per-hop re-validation, not a false pass). Restoring the
  // unconditional per-hop check turns it green again. This guard is real, unlike the hex-form
  // case above.
  it("re-validates DNS answers on every redirect hop, blocking a redirect to a blocked address", async () => {
    let resolveCalls = 0;
    const fetchFn = createHostPinnedFetch(["api.example.com"], {
      resolve: async () => {
        resolveCalls += 1;
        return resolveCalls === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }];
      },
      request: async () => ({
        status: 302,
        headers: { location: "https://api.example.com/other" },
        body: (async function* () {})()
      })
    });

    await expect(fetchFn("https://api.example.com/data")).rejects.toMatchObject({
      code: "blocked_address"
    });
    expect(resolveCalls).toBe(2);
  });
});
