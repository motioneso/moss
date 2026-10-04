import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The deployed policy is script-src 'self', so the offline page cannot carry inline script.
describe("offline surfaces under the deployed content security policy", () => {
  const publicFile = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../apps/web/public/${name}`, import.meta.url)), "utf8");

  it("keeps the offline page free of inline scripts and loads its name script from the site", () => {
    const html = publicFile("offline.html");
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script src="/offline-name.js">']);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("has the service worker cache the offline name script so it works offline", () => {
    expect(publicFile("service-worker.js")).toContain('"/offline-name.js"');
  });
});
