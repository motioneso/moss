/**
 * DF-V4-R4: "test-only" is a claim until something checks it. This proves the
 * API-side fixture bypass (apps/api/src/e2e-fetch-override.ts) carries the same
 * contract as the worker seam: inert in every default environment, throws the
 * worker's message when half-configured, host-scoped to the briefing sources'
 * manifest hosts when on, and rewriting pathname + search onto the fixture base
 * with init passed through.
 */
import { afterEach, describe, expect, it } from "vitest";

import { ESPN_FETCH_HOSTS } from "@moss/sports";
import { NEWS_FETCH_HOSTS } from "@moss/news";

import {
  briefingFixtureHosts,
  createApiE2eFixtureFetch,
  resolveApiE2eFetchOverride
} from "../../apps/api/src/e2e-fetch-override.js";

const ENV_KEYS = ["JARVIS_RUNTIME_MODE", "JARVIS_E2E_MODULE_FETCH_BASE"] as const;

describe("resolveApiE2eFetchOverride", () => {
  const original: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    JARVIS_RUNTIME_MODE: process.env.JARVIS_RUNTIME_MODE,
    JARVIS_E2E_MODULE_FETCH_BASE: process.env.JARVIS_E2E_MODULE_FETCH_BASE
  };

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("returns an object with no fetchFn key at all when the fixture var is unset", () => {
    delete process.env.JARVIS_RUNTIME_MODE;
    delete process.env.JARVIS_E2E_MODULE_FETCH_BASE;
    const result = resolveApiE2eFetchOverride();
    expect("fetchFn" in result).toBe(false);
    expect("e2eErrorDetail" in result).toBe(false);
  });

  it("throws the worker's message when the fixture var is set without e2e mode", () => {
    delete process.env.JARVIS_RUNTIME_MODE;
    process.env.JARVIS_E2E_MODULE_FETCH_BASE = "http://fixture.invalid:9999";
    expect(() => resolveApiE2eFetchOverride()).toThrow(/JARVIS_E2E_MODULE_FETCH_BASE/);
    expect(() => resolveApiE2eFetchOverride()).toThrow(/JARVIS_RUNTIME_MODE/);
  });

  it("passes fetchFn when both vars are set", () => {
    process.env.JARVIS_RUNTIME_MODE = "e2e";
    process.env.JARVIS_E2E_MODULE_FETCH_BASE = "http://fixture.invalid:9999";
    const result = resolveApiE2eFetchOverride();
    expect("fetchFn" in result).toBe(true);
    expect(typeof result.fetchFn).toBe("function");
    expect(result.e2eErrorDetail).toBe(true);
  });
});

describe("createApiE2eFixtureFetch", () => {
  it("covers the ESPN and news manifest hosts and nothing else by default", () => {
    const hosts = briefingFixtureHosts();
    expect(hosts).toContain("site.api.espn.com");
    expect(hosts).toContain("content.core.api.espn.com");
    // The news source declares its own feed hosts; the default set is exactly the
    // two briefing sources' manifest hosts, so both families rewrite below.
    for (const host of [...ESPN_FETCH_HOSTS, ...NEWS_FETCH_HOSTS]) {
      expect(hosts).toContain(host);
    }
    expect(hosts).toHaveLength(new Set([...ESPN_FETCH_HOSTS, ...NEWS_FETCH_HOSTS]).size);
    expect(hosts).not.toContain("evil.example.com");
  });

  it("passes a host outside the manifest list through to global fetch untouched", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input instanceof URL ? input.href : String(input), init]);
      return new Response("live");
    }) as typeof fetch;
    try {
      // Deliberate divergence from the worker seam: the API entry's fetchFn fans out
      // to every built-in client, so throwing here 500s unrelated modules (weather).
      // Only briefing hosts rewrite; the dataset runtime's own pinning still guards
      // clients that pin.
      const fixtureFetch = createApiE2eFixtureFetch("http://fixture.invalid:9999", [
        "site.api.espn.com"
      ]);
      const response = await fixtureFetch("https://api.open-meteo.com/v1/forecast?x=1");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("live");
      expect(calls).toHaveLength(1);
      expect(calls.at(0)?.[0]).toBe("https://api.open-meteo.com/v1/forecast?x=1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rewrites pathname + search onto the base and passes init through", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input instanceof URL ? input.href : String(input), init]);
      return new Response("ok");
    }) as typeof fetch;
    try {
      const fixtureFetch = createApiE2eFixtureFetch("http://fixture.invalid:9999", [
        "site.api.espn.com"
      ]);
      const controller = new AbortController();
      const response = await fixtureFetch(
        "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20260915",
        { signal: controller.signal }
      );
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls.at(0)?.[0]).toBe(
        "http://fixture.invalid:9999/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20260915"
      );
      expect(calls.at(0)?.[1]).toMatchObject({ signal: controller.signal });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rewrites a news manifest host onto the base too", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input instanceof URL ? input.href : String(input), init]);
      return new Response("ok");
    }) as typeof fetch;
    try {
      const newsHost = NEWS_FETCH_HOSTS[0]!;
      const fixtureFetch = createApiE2eFixtureFetch("http://fixture.invalid:9999");
      const response = await fixtureFetch(`https://${newsHost}/news/rss.xml?x=1`);
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls.at(0)?.[0]).toBe("http://fixture.invalid:9999/news/rss.xml?x=1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
