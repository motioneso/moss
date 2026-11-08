import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Hosts = {
  ts: string;
  api: string;
  rust: string;
  provider: string;
  fixture: unknown;
  capture: () => unknown;
  setFailure: (value: boolean) => void;
};
type Case = { name: string; path: string; body: unknown; expected: unknown };
type RouteCase = {
  name: string;
  actor?: string;
  config: unknown;
  capability: string;
  expected: { available: boolean; reason: string; modelId: string | null };
};
export async function runCases(hosts: Hosts) {
  let count = 0;
  const failures: string[] = [];
  async function check(name: string, execute: () => Promise<void>) {
    try {
      await execute();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "comparison failed";
      failures.push(`${name}: ${detail.slice(0, 600)}`);
      console.error("PARITY FAIL:", name);
    }
  }
  async function post(host: string, path: string, body: unknown) {
    const response = await fetch(host + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200, `unexpected status for ${path}`);
    const result: unknown = await response.json();
    return result;
  }
  function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(`rust-spike/platform/fixtures/${name}.json`, "utf8")) as T;
  }
  const cases = {
    contracts: fixture<Case[]>("contracts"),
    routing: [...fixture<RouteCase[]>("routing"), ...fixture<RouteCase[]>("routing-policy")],
    model: fixture<unknown>("model")
  };
  for (const c of cases.contracts) {
    await check(c.name, async () => {
      const ts = await post(hosts.ts, c.path, c.body);
      const rust = await post(hosts.rust, c.path, c.body);
      assert.deepEqual(ts, c.expected, c.name + " TypeScript expectation");
      assert.deepEqual(rust, c.expected, c.name + " Rust expectation");
      assert.deepEqual(rust, ts, c.name);
      console.log("PARITY PASS:", c.name);
      count++;
    });
  }
  await check("complete built-in app map", async () => {
    const tsMap = await post(hosts.ts, "/probe/app-map", hosts.fixture);
    const rsMap = await post(hosts.rust, "/probe/app-map", hosts.fixture);
    assert.deepEqual(rsMap, tsMap, "all built-in app-map declarations");
    console.log("PARITY PASS: complete built-in app map, including nested errors and remediations");
    count++;
  });
  for (const c of cases.routing) {
    await check(c.name, async () => {
      const actor = c.actor ?? "00000000-0000-4000-8000-000000000001";
      await post(hosts.ts, "/probe/configure", { actor, config: c.config });
      await post(hosts.rust, "/probe/configure", { actor, config: c.config });
      const headers = { authorization: `Bearer 40000000-0000-4000-8000-${actor.slice(-12)}` };
      const results = [];
      for (const host of [hosts.api, hosts.rust]) {
        const response = await fetch(`${host}/api/ai/capability-route/${c.capability}`, {
          headers
        });
        assert.equal(response.status, 200, c.name + " endpoint status");
        const value = (await response.json()) as {
          route: { available: boolean; reason: string; model: { id: string } | null };
        };
        const projected = {
          available: value.route.available,
          reason: value.route.reason,
          modelId: value.route.model?.id ?? null
        };
        assert.deepEqual(
          projected,
          c.expected,
          c.name + (host === hosts.api ? " TypeScript" : " Rust")
        );
        results.push(projected);
      }
      assert.deepEqual(results[0], results[1], c.name);
      console.log("PARITY PASS:", c.name);
      count++;
    });
  }
  for (const protocol of ["openai-compatible", "anthropic", "google"]) {
    await check(`HTTP adapter ${protocol}`, async () => {
      const body = {
        protocol,
        model: cases.model,
        messages: [{ role: "user", content: "fixture request" }],
        baseUrl: hosts.provider
      };
      const ts = await post(hosts.ts, "/probe/adapter", body);
      const tsRequest = hosts.capture();
      const rs = await post(hosts.rust, "/probe/adapter", body);
      const rsRequest = hosts.capture();
      assert.deepEqual(ts, { text: "fixture reply" });
      assert.deepEqual(rs, ts);
      assert.deepEqual(rsRequest, tsRequest, protocol + " real HTTP request");
      hosts.setFailure(true);
      assert.deepEqual(await post(hosts.ts, "/probe/adapter", body), { error: "Transport" });
      assert.deepEqual(await post(hosts.rust, "/probe/adapter", body), { error: "Transport" });
      hosts.setFailure(false);
      console.log("PARITY PASS: HTTP adapter request, response and scrubbed failure for", protocol);
      count += 2;
    });
    hosts.setFailure(false);
  }
  for (const host of [hosts.api, hosts.rust])
    assert.equal((await fetch(`${host}/api/ai/capability-route/chat`)).status, 401);
  if (failures.length) throw new Error(`Parity failures:\n${failures.join("\n")}`);
  console.log(
    `PARITY ${count}/${count} cases match; anonymous capability lookup refused on both servers`
  );
}
