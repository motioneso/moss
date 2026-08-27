import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerStaticWeb } from "../../apps/api/src/static-web.js";

describe("registerStaticWeb", () => {
  const oldEnv = process.env.JARVIS_WEB_DIST_DIR;

  afterEach(() => {
    if (oldEnv === undefined) {
      delete process.env.JARVIS_WEB_DIST_DIR;
    } else {
      process.env.JARVIS_WEB_DIST_DIR = oldEnv;
    }
  });

  function makeDist(): string {
    const dir = mkdtempSync(join(tmpdir(), "jarv1s-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, "assets", "app.js"), "console.log('jarv1s');");
    return dir;
  }

  it("serves static assets with nosniff and SPA CSP", async () => {
    const app = Fastify({ logger: false });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.body).toContain("jarv1s");
  });

  it("overrides the API helmet CSP for SPA HTML", async () => {
    const app = Fastify({ logger: false });
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"]
        }
      }
    });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({
      method: "GET",
      url: "/settings",
      headers: { accept: "text/html" }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).not.toContain("default-src 'none'");
  });

  it("falls back to index.html for browser SPA routes", async () => {
    const app = Fastify({ logger: false });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({
      method: "GET",
      url: "/settings/personal-data",
      headers: { accept: "text/html" }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<div id="root"></div>');
  });

  it("does not turn missing API routes into the SPA", async () => {
    const app = Fastify({ logger: false });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({
      method: "GET",
      url: "/api/missing",
      headers: { accept: "text/html" }
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root"></div>');
  });

  it("answers a missing hashed asset with a real, correctly-labeled 404", async () => {
    const app = Fastify({ logger: false });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({ method: "GET", url: "/assets/index-doesnotexist.css" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).not.toContain('<div id="root"></div>');
  });

  it("rejects path traversal", async () => {
    const app = Fastify({ logger: false });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({ method: "GET", url: "/%2e%2e/package.json" });

    expect(res.statusCode).toBe(404);
  });

  it("falls back to index.html for a bare GET / with no Accept header", async () => {
    const app = Fastify({ logger: false });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<div id="root"></div>');
  });

  it("does not turn missing routes into the SPA for an explicit Accept: application/json", async () => {
    const app = Fastify({ logger: false });
    registerStaticWeb(app, { distDir: makeDist() });

    const res = await app.inject({
      method: "GET",
      url: "/settings",
      headers: { accept: "application/json" }
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root"></div>');
  });
});
