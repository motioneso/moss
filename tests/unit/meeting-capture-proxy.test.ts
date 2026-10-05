import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conf = readFileSync(new URL("../../infra/nginx/jarv1s-web.conf", import.meta.url), "utf8");
const routes = readFileSync(
  new URL("../../packages/meetings/src/capture-routes.ts", import.meta.url),
  "utf8"
);

function locationBlock(match: string): string {
  const marker = `location ${match} {`;
  const start = conf.indexOf(marker);
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  return conf.slice(start + marker.length, conf.indexOf("}", start));
}

describe("meeting audio static-web proxy", () => {
  it("matches the API body cap only on the exact audio route", () => {
    const audio = locationBlock("= /api/meetings/capture/audio");
    const apiCap = routes.match(/"\/api\/meetings\/capture\/audio",[\s\S]*?bodyLimit: (\d+)/)?.[1];
    expect(apiCap).toBe("5200000");
    expect(audio).toContain(`client_max_body_size ${apiCap};`);
    expect(locationBlock("/api/")).not.toMatch(/client_max_body_size|proxy_request_buffering/);
  });

  it("streams audio without request buffering, including HTTP/1.1 chunked bodies", () => {
    const audio = locationBlock("= /api/meetings/capture/audio");
    expect(audio).toContain("proxy_request_buffering off;");
    expect(audio).toContain("proxy_http_version 1.1;");
    expect(audio).not.toMatch(/client_body_in_file_only\s+(on|clean)/);
    expect(audio).toContain("proxy_pass $api_upstream$request_uri;");
  });

  it("preserves API forwarding headers and timeouts on the audio override", () => {
    const audio = locationBlock("= /api/meetings/capture/audio");
    for (const directive of [
      "proxy_set_header Host $host;",
      "proxy_set_header X-Real-IP $remote_addr;",
      "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "proxy_set_header X-Forwarded-Proto $scheme;",
      "proxy_read_timeout 300s;"
    ]) {
      expect(audio).toContain(directive);
      expect(locationBlock("/api/")).toContain(directive);
    }
  });
});
