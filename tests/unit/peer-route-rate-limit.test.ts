import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { peerRouteRateLimitKey } from "@moss/module-sdk/server";

const root = resolve(import.meta.dirname, "../..");

async function buildServer() {
  const server = Fastify();
  await server.register(rateLimit, { global: false });
  const config = (max: number) => ({
    rateLimit: { max, timeWindow: "1 minute", keyGenerator: peerRouteRateLimitKey }
  });
  server.get("/a", { config: config(2) }, async () => "a");
  server.get("/b", { config: config(2) }, async () => "b");
  await server.ready();
  return server;
}

describe("peerRouteRateLimitKey", () => {
  it("keeps one route's traffic from using up another route's allowance", async () => {
    const server = await buildServer();
    for (let i = 0; i < 2; i += 1) {
      expect((await server.inject({ method: "GET", url: "/a" })).statusCode).toBe(200);
    }
    expect((await server.inject({ method: "GET", url: "/a" })).statusCode).toBe(429);
    expect((await server.inject({ method: "GET", url: "/b" })).statusCode).toBe(200);
    await server.close();
  });

  it("still bounds a single route per address", async () => {
    const server = await buildServer();
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      codes.push((await server.inject({ method: "GET", url: "/b" })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
    await server.close();
  });
});

describe("address-keyed limiters", () => {
  it.each([
    "apps/api/src/companion-routes.ts",
    "apps/api/src/companion-recording-routes.ts",
    "apps/api/src/server.ts",
    "packages/meetings/src/capture-routes.ts"
  ])("%s does not key a route on the bare address", (file) => {
    const source = readFileSync(resolve(root, file), "utf8");
    expect(source).not.toMatch(/keyGenerator:\s*\([^)]*\)\s*=>\s*`ip:\$\{[^}]*\.ip\}`/);
  });
});
