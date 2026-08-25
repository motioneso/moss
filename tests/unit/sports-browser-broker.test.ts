import { afterEach, describe, expect, it, vi } from "vitest";

import { SportsBrowserBroker } from "../../packages/sports/src/source/browser-broker.js";

const brokers: SportsBrowserBroker[] = [];

afterEach(() => {
  for (const broker of brokers) broker.dispose();
  brokers.length = 0;
  vi.useRealTimers();
});

describe("SportsBrowserBroker", () => {
  it("keeps authority in the API job and revokes duplicate or mismatched capabilities", async () => {
    const fetches: Array<{ url: string; allowedHosts: readonly string[] | undefined }> = [];
    const broker = new SportsBrowserBroker({
      fetch: async (url, options) => {
        fetches.push({ url, allowedHosts: options.allowedHosts });
        await options.beforeRequest?.({
          url: new URL(url),
          address: "93.184.216.34",
          family: 4,
          method: options.method ?? "GET",
          redirectCount: 0
        });
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/json",
          body: new TextEncoder().encode('{"items":[]}'),
          truncated: false,
          bytesRead: 12
        };
      }
    });
    brokers.push(broker);
    const control = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example", "static.publisher.example"]
    });

    await expect(
      broker.fetch({
        ...control,
        requestId: "request_1",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toMatchObject({ ok: true, bytesRead: 12 });
    expect(fetches).toEqual([
      {
        url: "https://publisher.example/news",
        allowedHosts: ["publisher.example", "static.publisher.example"]
      }
    ]);
    expect(broker.hasJob(control.jobId)).toBe(true);

    await expect(
      broker.fetch({
        ...control,
        requestId: "request_1",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "protocol_violation" });
    expect(broker.hasJob(control.jobId)).toBe(false);

    const second = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    await expect(
      broker.fetch({
        ...second,
        capability: "zzzzzzzzzzzzzzzzzzzzzz",
        requestId: "request_2",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "unauthorized" });
    expect(broker.hasJob(second.jobId)).toBe(false);
  });

  it("revokes on cancellation or deadline and aborts every in-flight safe fetch", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const broker = new SportsBrowserBroker({
      fetch: async (_url, options) =>
        new Promise((resolve) => {
          markStarted?.();
          options.signal.addEventListener(
            "abort",
            () => resolve({ ok: false, reason: "network", detail: "aborted" }),
            { once: true }
          );
        })
    });
    brokers.push(broker);
    const control = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    const fetchResult = broker.fetch({
      ...control,
      requestId: "request_1",
      method: "GET",
      resourceType: "fetch"
    });
    await started;
    broker.cancelJob(control.jobId);
    await expect(fetchResult).resolves.toEqual({
      ok: false,
      reason: "aborted",
      status: undefined,
      bytesRead: undefined
    });
    expect(broker.hasJob(control.jobId)).toBe(false);

    vi.useFakeTimers();
    const expiring = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(broker.hasJob(expiring.jobId)).toBe(false);
  });

  it("counts redirects and aggregate bytes against API-owned budgets", async () => {
    let mode: "redirects" | "bytes" = "redirects";
    let fetchCalls = 0;
    const broker = new SportsBrowserBroker({
      fetch: async (url, options) => {
        fetchCalls += 1;
        if (mode === "redirects") {
          for (let redirectCount = 0; redirectCount <= 40; redirectCount += 1) {
            if (
              options.beforeRequest({
                url: new URL(url),
                address: "93.184.216.34",
                family: 4,
                method: options.method,
                redirectCount
              }) === false
            ) {
              return { ok: false, reason: "blocked" };
            }
          }
        } else {
          options.beforeRequest({
            url: new URL(url),
            address: "93.184.216.34",
            family: 4,
            method: options.method,
            redirectCount: 0
          });
        }
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/json",
          body: new Uint8Array(),
          truncated: false,
          bytesRead: mode === "bytes" ? 2 * 1024 * 1024 : 0
        };
      }
    });
    brokers.push(broker);
    const redirectJob = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    await expect(
      broker.fetch({
        ...redirectJob,
        requestId: "redirects",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "budget_exceeded", bytesRead: 0 });
    expect(broker.hasJob(redirectJob.jobId)).toBe(false);

    mode = "bytes";
    fetchCalls = 0;
    const byteJob = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    for (let index = 0; index < 5; index += 1) {
      await expect(
        broker.fetch({
          ...byteJob,
          requestId: `bytes_${index}`,
          method: "GET",
          resourceType: "fetch"
        })
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      broker.fetch({
        ...byteJob,
        requestId: "bytes_5",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "budget_exceeded" });
    expect(fetchCalls).toBe(5);
    expect(broker.hasJob(byteJob.jobId)).toBe(false);
  });

  it("revokes the job when renderer concurrency exceeds four requests", async () => {
    let started = 0;
    let releaseStarted: (() => void) | undefined;
    const fourStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const broker = new SportsBrowserBroker({
      fetch: async (_url, options) =>
        new Promise((resolve) => {
          started += 1;
          if (started === 4) releaseStarted?.();
          options.signal.addEventListener(
            "abort",
            () => resolve({ ok: false, reason: "network", detail: "aborted" }),
            { once: true }
          );
        })
    });
    brokers.push(broker);
    const control = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    const active = Array.from({ length: 4 }, (_, index) =>
      broker.fetch({
        ...control,
        requestId: `active_${index}`,
        method: "GET",
        resourceType: "fetch"
      })
    );
    await fourStarted;
    await expect(
      broker.fetch({
        ...control,
        requestId: "active_4",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "budget_exceeded" });
    await expect(Promise.all(active)).resolves.toEqual(
      Array.from({ length: 4 }, () => ({
        ok: false,
        reason: "aborted",
        status: undefined,
        bytesRead: undefined
      }))
    );
    expect(broker.hasJob(control.jobId)).toBe(false);
  });

  it("reserves aggregate byte allowance before concurrent fetches start", async () => {
    let blocking = false;
    const maxBytes: number[] = [];
    const broker = new SportsBrowserBroker({
      fetch: async (url, options) => {
        maxBytes.push(options.maxBytes);
        options.beforeRequest({
          url: new URL(url),
          address: "93.184.216.34",
          family: 4,
          method: options.method,
          redirectCount: 0
        });
        if (blocking) {
          return new Promise((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => resolve({ ok: false, reason: "network", detail: "aborted" }),
              { once: true }
            );
          });
        }
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/json",
          body: new Uint8Array(),
          truncated: false,
          bytesRead: 2 * 1024 * 1024
        };
      }
    });
    brokers.push(broker);
    const control = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    for (let index = 0; index < 3; index += 1) {
      await broker.fetch({
        ...control,
        requestId: `prime_${index}`,
        method: "GET",
        resourceType: "fetch"
      });
    }

    blocking = true;
    const first = broker.fetch({
      ...control,
      requestId: "concurrent_1",
      method: "GET",
      resourceType: "fetch"
    });
    const second = broker.fetch({
      ...control,
      requestId: "concurrent_2",
      method: "GET",
      resourceType: "fetch"
    });
    await expect(
      broker.fetch({
        ...control,
        requestId: "concurrent_3",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "budget_exceeded" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: false, reason: "aborted", status: undefined, bytesRead: undefined },
      { ok: false, reason: "aborted", status: undefined, bytesRead: undefined }
    ]);
    expect(maxBytes).toEqual(Array.from({ length: 5 }, () => 2 * 1024 * 1024));
    expect(broker.hasJob(control.jobId)).toBe(false);
  });

  it("retains at most five candidate responses and clears them when control completes", async () => {
    const broker = new SportsBrowserBroker({
      fetch: async (url, options) => {
        options.beforeRequest({
          url: new URL(url),
          address: "93.184.216.34",
          family: 4,
          method: options.method,
          redirectCount: 0
        });
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/json",
          body: new TextEncoder().encode(url),
          truncated: false,
          bytesRead: url.length
        };
      }
    });
    brokers.push(broker);
    const control = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    for (let index = 0; index < 6; index += 1) {
      await broker.fetch({
        ...control,
        url: `https://publisher.example/news/${index}`,
        requestId: `candidate_${index}`,
        method: "GET",
        resourceType: "fetch"
      });
    }

    expect(broker.completeJob(control.jobId, control.capability)).toMatchObject({
      ok: true,
      evidence: [
        { requestId: "candidate_0" },
        { requestId: "candidate_1" },
        { requestId: "candidate_2" },
        { requestId: "candidate_3" },
        { requestId: "candidate_4" }
      ]
    });
    expect(broker.hasJob(control.jobId)).toBe(false);
  });
});
