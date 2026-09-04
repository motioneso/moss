import { afterEach, describe, expect, it } from "vitest";

import {
  createRobotsGate,
  fetchWebResource,
  fetchWebResourceBytes,
  isBlockedIp,
  RateLimitExceededError,
  readWebPage,
  setWebHttpTransportForTests,
  setWebFetchForTests,
  setWebHostResolverForTests,
  setWebSearchProviderForTests,
  webModuleManifest,
  webReadExecute,
  webSearchExecute
} from "@moss/web-research";
import type { ModuleAssistantToolManifest } from "@moss/module-sdk";

afterEach(() => {
  setWebFetchForTests(undefined);
  setWebHttpTransportForTests(undefined);
  setWebHostResolverForTests(undefined);
  setWebSearchProviderForTests(undefined);
});

describe("web research manifest", () => {
  it("declares required web.search and web.read assistant tools", () => {
    expect(webModuleManifest.id).toBe("web");
    expect(webModuleManifest.lifecycle).toBe("required");
    expect(webModuleManifest.availability).toMatchObject({
      defaultEnabled: true,
      required: true
    });
    expect(webModuleManifest.routes ?? []).toEqual([]);
    expect(webModuleManifest.navigation ?? []).toEqual([]);

    const tools: readonly ModuleAssistantToolManifest[] = webModuleManifest.assistantTools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(["web.search", "web.read"]);
    expect(tools.every((tool) => tool.permissionId === "web.research")).toBe(true);
    expect(tools.find((t) => t.name === "web.search")?.risk).toBe("read");

    // web.read fetches arbitrary URLs (#359) and is the v0.1.0 audit's prompt-injection-to-
    // exfiltration finding — it stays confirm_always with no actionFamilyId/executionPolicy so
    // policy.ts:40 confirms every call (Opus security review, PR #1268; #1263 Task 5).
    const webRead = tools.find((t) => t.name === "web.read");
    expect(webRead?.risk).toBe("write");
    expect(webRead?.actionFamilyId).toBeUndefined();
    expect(webRead?.executionPolicy).toBeUndefined();
    expect(webRead?.selfOperationGrant).toBe("confirm_always");
  });
});

describe("web.read", () => {
  it("rejects unsafe literal and DNS-resolved private URLs", async () => {
    let fetchCalls = 0;
    setWebFetchForTests(async () => {
      fetchCalls += 1;
      return new Response("ok");
    });
    setWebHostResolverForTests(async (hostname) =>
      hostname === "public.test" ? [{ address: "10.0.0.1", family: 4 }] : []
    );

    const result = await webReadExecute(
      {},
      {
        urls: [
          "file:///etc/passwd",
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          "http://10.0.0.1",
          "http://169.254.169.254",
          "javascript:alert(1)",
          "https://public.test/ok"
        ]
      },
      { actorUserId: "u", requestId: "r", chatSessionId: "c" }
    );

    expect(result.data.documents).toHaveLength(0);
    expect(result.data.trace).toMatchObject({
      requestedUrlCount: 7,
      fetchedUrlCount: 0,
      skippedUrlCount: 7
    });
    expect(fetchCalls).toBe(0);
  });

  it("blocks IPv6 unspecified (::), this-network (0.0.0.0/8), and CGNAT (100.64.0.0/10)", async () => {
    expect(isBlockedIp("::")).toBe(true); // IPv6 unspecified — routes to loopback on Linux
    expect(isBlockedIp("0.1.2.3")).toBe(true); // this-network /8 (broader than old single-host 0.0.0.0)
    expect(isBlockedIp("100.64.0.1")).toBe(true); // CGNAT (RFC 6598)
    expect(isBlockedIp("100.127.255.255")).toBe(true); // end of CGNAT range
    expect(isBlockedIp("100.128.0.1")).toBe(false); // just outside CGNAT — public
    // Node.js BlockList correctly cross-checks IPv4-mapped IPv6 against IPv4 subnets
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true); // AWS metadata via IPv4-mapped
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true); // same in hex notation
    // IANA special ranges added for completeness
    expect(isBlockedIp("192.0.2.1")).toBe(true); // TEST-NET-1
    expect(isBlockedIp("198.18.1.1")).toBe(true); // benchmarking
    expect(isBlockedIp("198.51.100.1")).toBe(true); // TEST-NET-2
    expect(isBlockedIp("203.0.113.1")).toBe(true); // TEST-NET-3
    expect(isBlockedIp("240.0.0.1")).toBe(true); // reserved Class E
    expect(isBlockedIp("2001:db8::1")).toBe(true); // IPv6 documentation
  });

  it("extracts readable text, caps content, and reports trace", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebFetchForTests(
      async () =>
        new Response(
          `<html><head><title>T</title><script>bad()</script></head><body><nav>nav</nav><main><h1>Hello</h1><p>${"a".repeat(20_000)}</p></main></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        )
    );

    const result = await webReadExecute(
      {},
      { urls: ["https://example.com/a"] },
      {
        actorUserId: "u",
        requestId: "r",
        chatSessionId: "c"
      }
    );

    const [doc] = result.data.documents as Array<{
      title: string;
      text: string;
      truncated: boolean;
      url: string;
    }>;
    expect(doc).toBeDefined();
    if (!doc) throw new Error("expected document");
    expect(doc.url).toBe("https://example.com/a");
    expect(doc.title).toBe("T");
    expect(doc.text).toContain("Hello");
    expect(doc.text).not.toContain("bad()");
    expect(doc.truncated).toBe(true);
    expect(result.data.trace).toMatchObject({
      requestedUrlCount: 1,
      fetchedUrlCount: 1,
      skippedUrlCount: 0
    });
  });

  it("validates each redirect target before following it", async () => {
    let fetchCalls = 0;
    setWebHostResolverForTests(async (hostname) =>
      hostname === "example.com" ? [{ address: "93.184.216.34", family: 4 }] : []
    );
    setWebFetchForTests(async () => {
      fetchCalls += 1;
      return new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/private" }
      });
    });

    const result = await webReadExecute(
      {},
      { urls: ["https://example.com/redirect"] },
      {
        actorUserId: "u",
        requestId: "r",
        chatSessionId: "c"
      }
    );

    expect(fetchCalls).toBe(1);
    expect(result.data.documents).toHaveLength(0);
    expect(result.data.trace).toMatchObject({
      requestedUrlCount: 1,
      fetchedUrlCount: 0,
      skippedUrlCount: 1
    });
  });

  it("connects to the checked DNS address while preserving the original host", async () => {
    const requests: Array<{ connectHost: string; hostHeader: string; servername?: string }> = [];
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async (request) => {
      requests.push({
        connectHost: request.connectHost,
        hostHeader: request.hostHeader,
        servername: request.servername
      });
      return new Response("<title>ok</title><main>safe</main>", { status: 200 });
    });

    const result = await webReadExecute(
      {},
      { urls: ["https://example.com/a"] },
      { actorUserId: "u", requestId: "r", chatSessionId: "c" }
    );

    expect(result.data.documents).toHaveLength(1);
    expect(requests).toEqual([
      {
        connectHost: "93.184.216.34",
        hostHeader: "example.com",
        servername: "example.com"
      }
    ]);
  });

  it("blocks IPv4-mapped IPv6 private and loopback addresses", async () => {
    let fetchCalls = 0;
    setWebFetchForTests(async () => {
      fetchCalls += 1;
      return new Response("ok");
    });

    const result = await webReadExecute(
      {},
      {
        urls: [
          "http://[::ffff:127.0.0.1]/",
          "http://[::ffff:10.0.0.1]/",
          "http://[::ffff:169.254.1.1]/",
          "http://[fc00::1]/",
          "http://[fe80::1]/",
          "http://[::1]/"
        ]
      },
      { actorUserId: "u", requestId: "r", chatSessionId: "c" }
    );

    expect(isBlockedIp("[::ffff:7f00:1]")).toBe(true);
    expect(result.data.documents).toHaveLength(0);
    expect(result.data.trace).toMatchObject({
      requestedUrlCount: 6,
      fetchedUrlCount: 0,
      skippedUrlCount: 6
    });
    expect(fetchCalls).toBe(0);
  });
});

describe("fetchWebResource", () => {
  it("returns exact bounded bytes without text conversion", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(
      async () => new Response(Uint8Array.from([0, 255, 1, 2]), { status: 200 })
    );

    const exact = await fetchWebResourceBytes("https://example.com/image");
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect([...exact.body]).toEqual([0, 255, 1, 2]);
      expect(exact.truncated).toBe(false);
    }

    const capped = await fetchWebResourceBytes("https://example.com/image", { maxBytes: 2 });
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect([...capped.body]).toEqual([0, 255]);
      expect(capped.truncated).toBe(true);
    }
  });

  it("keeps HTTPS, redirect validation, and rate limits on the byte path", async () => {
    const requests: string[] = [];
    setWebHostResolverForTests(async (hostname) => [
      {
        address: hostname === "private-target.example" ? "10.0.0.1" : "93.184.216.34",
        family: 4
      }
    ]);
    setWebHttpTransportForTests(async (request) => {
      requests.push(request.connectHost);
      return new Response("", {
        status: 302,
        headers: { location: "https://private-target.example/image" }
      });
    });

    await expect(
      fetchWebResourceBytes("http://good.example/image", { requireHttps: true })
    ).resolves.toEqual({ ok: false, reason: "not_https" });
    await expect(fetchWebResourceBytes("https://good.example/image")).resolves.toEqual({
      ok: false,
      reason: "blocked"
    });
    expect(requests).toEqual(["93.184.216.34"]);

    await expect(
      fetchWebResourceBytes("https://good.example/image", {
        rateLimiter: { acquire: async () => Promise.reject(new RateLimitExceededError()) }
      })
    ).resolves.toEqual({ ok: false, reason: "rate_limited" });
  });

  it("enforces HTTPS without changing readWebPage compatibility", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async () => new Response("ok", { status: 200 }));

    await expect(fetchWebResource("http://example.com", { requireHttps: true })).resolves.toEqual({
      ok: false,
      reason: "not_https"
    });
    await expect(readWebPage("http://example.com")).resolves.toMatchObject({ ok: true });
  });

  it("revalidates redirects and rejects private or downgraded targets", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://good.example/downgraded" }
        })
    );
    await expect(
      fetchWebResource("https://good.example", { requireHttps: true })
    ).resolves.toMatchObject({ ok: false, reason: "not_https" });

    setWebHttpTransportForTests(
      async () =>
        new Response("", { status: 302, headers: { location: "https://169.254.169.254/" } })
    );
    await expect(fetchWebResource("https://good.example")).resolves.toMatchObject({
      ok: false,
      reason: "blocked"
    });
  });

  it("enforces an exact allowed host set on the initial request and every redirect", async () => {
    const requests: string[] = [];
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async (request) => {
      requests.push(request.url.hostname);
      if (request.url.hostname === "publisher.example") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://static.publisher.example/news" }
        });
      }
      return new Response("headline", { status: 200 });
    });

    await expect(
      fetchWebResource("https://outside.example/news", {
        allowedHosts: ["publisher.example"]
      })
    ).resolves.toEqual({ ok: false, reason: "blocked" });
    expect(requests).toEqual([]);

    await expect(
      fetchWebResource("https://publisher.example/news", {
        allowedHosts: ["publisher.example", "static.publisher.example"]
      })
    ).resolves.toMatchObject({ ok: true, body: "headline" });
    expect(requests).toEqual(["publisher.example", "static.publisher.example"]);

    requests.length = 0;
    await expect(
      fetchWebResource("https://publisher.example/news", {
        allowedHosts: ["publisher.example"]
      })
    ).resolves.toEqual({ ok: false, reason: "blocked" });
    expect(requests).toEqual(["publisher.example"]);
  });

  it("applies the fixed method, allowlisted headers, and policy hook on every request", async () => {
    const requests: Array<{
      method: string;
      headers: Readonly<Record<string, string>>;
    }> = [];
    const hops: Array<{ hostname: string; address: string; redirectCount: number }> = [];
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async (request) => {
      requests.push({ method: request.method, headers: request.headers });
      if (request.url.hostname === "publisher.example") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://static.publisher.example/news" }
        });
      }
      return new Response(null, { status: 200 });
    });

    await expect(
      fetchWebResource("https://publisher.example/news", {
        allowedHosts: ["publisher.example", "static.publisher.example"],
        method: "HEAD",
        requestHeaders: {
          Accept: "text/html",
          "Accept-Language": "en-US"
        },
        beforeRequest: (hop) => {
          hops.push({
            hostname: hop.url.hostname,
            address: hop.address,
            redirectCount: hop.redirectCount
          });
        }
      })
    ).resolves.toMatchObject({ ok: true, body: "" });
    expect(requests).toEqual([
      {
        method: "HEAD",
        headers: { accept: "text/html", "accept-language": "en-US" }
      },
      {
        method: "HEAD",
        headers: { accept: "text/html", "accept-language": "en-US" }
      }
    ]);
    expect(hops).toEqual([
      { hostname: "publisher.example", address: "93.184.216.34", redirectCount: 0 },
      { hostname: "static.publisher.example", address: "93.184.216.34", redirectCount: 1 }
    ]);

    requests.length = 0;
    await expect(
      fetchWebResource("https://publisher.example/news", {
        requestHeaders: { Authorization: "secret" }
      })
    ).resolves.toEqual({ ok: false, reason: "blocked" });
    expect(requests).toEqual([]);
  });

  it("cancels redirect bodies and reports only the actual final bytes read", async () => {
    let redirectBodyCancelled = false;
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async (request) => {
      if (request.url.hostname === "publisher.example") {
        return new Response(
          new ReadableStream({
            cancel: () => {
              redirectBodyCancelled = true;
            }
          }),
          {
            status: 302,
            headers: { location: "https://static.publisher.example/news" }
          }
        );
      }
      return new Response("hello", { status: 200 });
    });

    const result = await fetchWebResource("https://publisher.example/news", {
      allowedHosts: ["publisher.example", "static.publisher.example"]
    });

    expect(redirectBodyCancelled).toBe(true);
    expect(result).toMatchObject({ ok: true, body: "hello", bytesRead: 5 });
  });

  it("cancels HTTP error bodies and returns Retry-After even when cancellation fails", async () => {
    let cancelled = false;
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
              throw new Error("synthetic cancellation failure");
            }
          }),
          { status: 429, headers: { "retry-after": "2" } }
        )
    );

    await expect(fetchWebResource("https://publisher.example/news")).resolves.toEqual({
      ok: false,
      reason: "http_error",
      status: 429,
      retryAfter: "2"
    });
    expect(cancelled).toBe(true);
  });

  it("accepts only explicitly allowed final response content types", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(
      async () =>
        new Response("<html>nope</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })
    );

    await expect(
      fetchWebResource("https://example.com/news", {
        allowedContentTypes: ["application/json"]
      })
    ).resolves.toEqual({
      ok: false,
      reason: "blocked",
      detail: "unsupported_content_type",
      status: 200
    });

    setWebHttpTransportForTests(
      async () =>
        new Response('{"items":[]}', {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        })
    );
    await expect(
      fetchWebResource("https://example.com/news", {
        allowedContentTypes: ["application/json"]
      })
    ).resolves.toMatchObject({ ok: true, body: '{"items":[]}' });
  });

  it("rejects oversized declared response lengths before reading bodies", async () => {
    let cancelledBodies = 0;
    let requestCount = 0;
    const oversizedBody = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        cancel: () => {
          cancelledBodies += 1;
        }
      });
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async () => {
      requestCount += 1;
      return new Response(oversizedBody(), {
        status: 302,
        headers: {
          "content-length": "9",
          location: "https://example.com/final"
        }
      });
    });

    await expect(
      fetchWebResource("https://example.com/news", {
        maxBytes: 4,
        rejectOversizedResponses: true
      })
    ).resolves.toEqual({
      ok: false,
      reason: "blocked",
      detail: "response_too_large",
      status: 302,
      bytesRead: 0
    });
    expect(requestCount).toBe(1);
    expect(cancelledBodies).toBe(1);

    setWebHttpTransportForTests(
      async () =>
        new Response(oversizedBody(), {
          status: 200,
          headers: { "content-length": "9" }
        })
    );
    await expect(
      fetchWebResource("https://example.com/news", {
        maxBytes: 4,
        rejectOversizedResponses: true
      })
    ).resolves.toEqual({
      ok: false,
      reason: "blocked",
      detail: "response_too_large",
      status: 200,
      bytesRead: 0
    });
    expect(cancelledBodies).toBe(2);
  });

  it("rejects streamed overflow and misleading final content lengths", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(
      async () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode("abcdef"));
              controller.close();
            }
          }),
          { status: 200 }
        )
    );

    await expect(
      fetchWebResource("https://example.com/news", {
        maxBytes: 4,
        rejectOversizedResponses: true
      })
    ).resolves.toEqual({
      ok: false,
      reason: "blocked",
      detail: "response_too_large",
      status: 200,
      bytesRead: 6
    });

    setWebHttpTransportForTests(
      async () =>
        new Response("hello", {
          status: 200,
          headers: { "content-length": "2" }
        })
    );
    await expect(
      fetchWebResource("https://example.com/news", {
        maxBytes: 10,
        rejectOversizedResponses: true
      })
    ).resolves.toEqual({
      ok: false,
      reason: "blocked",
      detail: "invalid_response",
      status: 200,
      bytesRead: 5
    });
  });

  it("pins the validated address and blocks a rebind-shaped redirect", async () => {
    const requests: string[] = [];
    setWebHostResolverForTests(async (hostname) => [
      {
        address: hostname === "rebound.example" ? "10.0.0.1" : "93.184.216.34",
        family: 4
      }
    ]);
    setWebHttpTransportForTests(async (request) => {
      requests.push(request.connectHost);
      return new Response("", {
        status: 302,
        headers: { location: "https://rebound.example/private" }
      });
    });

    await expect(fetchWebResource("https://good.example")).resolves.toMatchObject({
      ok: false,
      reason: "blocked"
    });
    expect(requests).toEqual(["93.184.216.34"]);
  });

  it.each(["http://[::]/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/"])(
    "blocks adversarial literal %s before transport",
    async (url) => {
      let calls = 0;
      setWebHttpTransportForTests(async () => {
        calls += 1;
        return new Response("nope");
      });
      await expect(fetchWebResource(url)).resolves.toMatchObject({
        ok: false,
        reason: "blocked"
      });
      expect(calls).toBe(0);
    }
  );

  it("consults robots before the page and fails closed", async () => {
    const paths: string[] = [];
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async (request) => {
      paths.push(request.url.pathname);
      return new Response("User-agent: *\nDisallow: /private", { status: 200 });
    });

    await expect(
      fetchWebResource("https://example.com/private", { robots: createRobotsGate() })
    ).resolves.toMatchObject({ ok: false, reason: "robots" });
    expect(paths).toEqual(["/robots.txt"]);

    setWebHttpTransportForTests(async () => new Response("unavailable", { status: 503 }));
    await expect(
      fetchWebResource("https://other.example/story", { robots: createRobotsGate() })
    ).resolves.toMatchObject({ ok: false, reason: "robots" });
  });

  // Bug: a bare domain that redirects everything to its www address (including robots.txt
  // itself) used to fail the robots check, because the check only looked at the raw robots.txt
  // response and a redirect is neither "allowed" nor "not found". It should follow the redirect
  // and read robots.txt from wherever it actually ends up, the same way a browser would.
  it("follows a redirect on robots.txt so a bare domain that redirects to its www address still works", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async (request) => {
      if (request.url.hostname === "bare.example" && request.url.pathname === "/robots.txt") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://www.bare.example/robots.txt" }
        });
      }
      if (request.url.hostname === "www.bare.example" && request.url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response("the page", { status: 200 });
    });

    await expect(
      fetchWebResource("https://bare.example/story", { robots: createRobotsGate() })
    ).resolves.toMatchObject({ ok: true, body: "the page" });
  });

  it("maps rate limits, truncation, and timeout", async () => {
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async () => new Response("abcdef", { status: 200 }));
    await expect(
      fetchWebResource("https://example.com", {
        rateLimiter: {
          acquire: async () => {
            throw new RateLimitExceededError();
          }
        }
      })
    ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    await expect(fetchWebResource("https://example.com", { maxBytes: 3 })).resolves.toMatchObject({
      ok: true,
      body: "abc",
      truncated: true
    });

    setWebHttpTransportForTests(
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    await expect(fetchWebResource("https://example.com", { timeoutMs: 1 })).resolves.toMatchObject({
      ok: false,
      reason: "timeout"
    });
  });

  it("propagates caller cancellation without reporting a timeout", async () => {
    const caller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          markStarted?.();
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );

    const result = fetchWebResource("https://example.com", { signal: caller.signal });
    await started;
    caller.abort();

    await expect(result).resolves.toEqual({
      ok: false,
      reason: "network",
      detail: "aborted"
    });
  });

  it("times out a resolver that never settles", async () => {
    let transportCalls = 0;
    setWebHostResolverForTests(() => new Promise(() => {}));
    setWebHttpTransportForTests(async () => {
      transportCalls += 1;
      return new Response("unexpected");
    });

    await expect(fetchWebResource("https://example.com", { timeoutMs: 1 })).resolves.toEqual({
      ok: false,
      reason: "timeout"
    });
    expect(transportCalls).toBe(0);
  }, 100);

  it("does not start transport when a limiter wait exceeds the timeout", async () => {
    let transportCalls = 0;
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebHttpTransportForTests(async () => {
      transportCalls += 1;
      return new Response("unexpected");
    });

    await expect(
      fetchWebResource("https://example.com", {
        timeoutMs: 1,
        rateLimiter: { acquire: () => new Promise((resolve) => setTimeout(resolve, 50)) }
      })
    ).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(transportCalls).toBe(0);
  });
});

describe("web.search", () => {
  it("caps input and provider results", async () => {
    setWebSearchProviderForTests({
      name: "fake",
      search: async ({ limit }) => ({
        results: Array.from({ length: limit + 2 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.com/${index}`,
          snippet: "snippet",
          publishedAt: index === 0 ? "2026-06-19" : undefined
        })),
        trace: { provider: "fake" }
      })
    });

    const result = await webSearchExecute(
      {},
      { query: "x".repeat(500), limit: 99 },
      {
        actorUserId: "u",
        requestId: "r",
        chatSessionId: "c"
      }
    );

    expect(result.data.query).toHaveLength(200);
    expect(result.data.results).toHaveLength(5);
    expect(result.data.trace).toMatchObject({
      provider: "fake",
      resultCount: 5,
      limitApplied: true,
      queryTruncated: true
    });
  });
});
