import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SERVICE_WORKER_CSP, SPA_CSP } from "../../apps/api/src/static-web.js";

// Registration order: sports' ESPN hosts, then the news catalog's (sorted) artwork hosts.
const EXPECTED_IMG_SRC =
  "img-src 'self' data: https://a.espncdn.com https://s.espncdn.com https://s.secure.espncdn.com" +
  " https://espnmedia-cdn.akamaized.net" +
  " https://assets.apnews.com https://cdn.arstechnica.net https://dims.apnews.com" +
  " https://i.guim.co.uk https://ichef.bbci.co.uk" +
  " https://media.npr.org https://media.wired.com https://npr.brightspotcdn.com" +
  " https://platform.theverge.com https://static01.nyt.com";

describe("SPA CSP image hosts", () => {
  it("folds every module's declared image hosts into img-src", () => {
    expect(SPA_CSP).toContain(EXPECTED_IMG_SRC);
  });

  it("keeps every other directive unchanged", () => {
    expect(SPA_CSP).toContain("default-src 'self'");
    expect(SPA_CSP).toContain("script-src 'self'");
    expect(SPA_CSP).toContain("frame-ancestors 'none'");
  });

  it("keeps the nginx CSP img-src in sync with the API CSP", () => {
    const conf = readFileSync(
      fileURLToPath(new URL("../../infra/nginx/jarv1s-web.conf", import.meta.url)),
      "utf8"
    );
    expect(conf).toContain(EXPECTED_IMG_SRC);
  });
});

// The worker re-fetches the page's images itself, and CSP judges a worker fetch() by
// connect-src, so every img-src host must also be a worker connect-src host.
const EXPECTED_WORKER_CONNECT_SRC = EXPECTED_IMG_SRC.replace(
  "img-src 'self' data:",
  "connect-src 'self'"
);

describe("service worker CSP", () => {
  it("lets the worker fetch every image host the page may show", () => {
    expect(SERVICE_WORKER_CSP).toContain(EXPECTED_WORKER_CONNECT_SRC);
    expect(SERVICE_WORKER_CSP).toContain(EXPECTED_IMG_SRC);
  });

  it("keeps the page itself on connect-src 'self'", () => {
    expect(SPA_CSP).toContain("connect-src 'self';");
    expect(SPA_CSP).not.toContain("connect-src 'self' https://");
  });

  it("keeps the nginx service worker CSP in sync with the API", () => {
    const conf = readFileSync(
      fileURLToPath(new URL("../../infra/nginx/jarv1s-web.conf", import.meta.url)),
      "utf8"
    );
    const block = conf.slice(conf.indexOf("location = /service-worker.js"));
    expect(block).toContain(EXPECTED_WORKER_CONNECT_SRC);
  });
});
