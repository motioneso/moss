import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SPA_CSP } from "../../apps/api/src/static-web.js";

// Registration order: sports' ESPN hosts, then the news catalog's (sorted) artwork hosts.
const EXPECTED_IMG_SRC =
  "img-src 'self' data: https://a.espncdn.com https://s.espncdn.com https://s.secure.espncdn.com" +
  " https://espnmedia-cdn.akamaized.net" +
  " https://cdn.arstechnica.net https://i.guim.co.uk https://ichef.bbci.co.uk" +
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
