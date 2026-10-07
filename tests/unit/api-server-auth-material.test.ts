import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";

import { hasAuthMaterial } from "../../apps/api/src/server.js";

function request(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as FastifyRequest;
}

describe("hasAuthMaterial", () => {
  it("detects bearer or cookie auth material", () => {
    expect(hasAuthMaterial(request({ authorization: "Bearer abc", cookie: undefined }))).toBe(true);
    expect(hasAuthMaterial(request({ authorization: undefined, cookie: "sid=abc" }))).toBe(true);
  });

  it("counts an act-as grant header as auth material (#3065)", () => {
    expect(hasAuthMaterial(request({ "x-moss-act-as": "grant-value" }))).toBe(true);
  });

  it("treats missing or blank auth headers as anonymous", () => {
    expect(hasAuthMaterial(request({ authorization: undefined, cookie: undefined }))).toBe(false);
    expect(hasAuthMaterial(request({ authorization: "   ", cookie: "" }))).toBe(false);
  });
});
