import { createHash, randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { mcpSessionRateLimitKey, sessionRateLimitKey } from "@moss/module-sdk/server";

// Build a minimal FastifyRequest stand-in carrying only the fields the helpers read.
function req(opts: { authorization?: string; cookie?: string; ip?: string }): FastifyRequest {
  return {
    headers: { authorization: opts.authorization, cookie: opts.cookie },
    ip: opts.ip ?? "203.0.113.7"
  } as unknown as FastifyRequest;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

describe("sessionRateLimitKey (UUID-shaped session bearer policy)", () => {
  it("hashes a UUID-shaped Bearer token into the bearer namespace, never leaking the raw token", () => {
    const token = "40000000-0000-4000-8000-000000000001";
    const key = sessionRateLimitKey(req({ authorization: `Bearer ${token}` }));
    expect(key).toBe(`bearer:${hash(token)}`);
    expect(key).not.toContain(token);
  });

  it("falls back to the shared per-IP bucket for a malformed (non-UUID) Bearer token", () => {
    const a = sessionRateLimitKey(
      req({ authorization: "Bearer junk-token-1", ip: "198.51.100.4" })
    );
    const b = sessionRateLimitKey(
      req({ authorization: "Bearer junk-token-2", ip: "198.51.100.4" })
    );
    // Two DIFFERENT junk tokens from the same peer must collapse to one bucket — no minting.
    expect(a).toBe("ip:198.51.100.4");
    expect(b).toBe("ip:198.51.100.4");
    expect(a).toBe(b);
  });

  it("hashes the better-auth session cookie into the cookie namespace", () => {
    const value = "cookie-session-value-xyz";
    const key = sessionRateLimitKey(req({ cookie: `better-auth.session_token=${value}; other=1` }));
    expect(key).toBe(`cookie:${hash(value)}`);
    expect(key).not.toContain(value);
  });

  it("recognizes the __Secure- prefixed cookie (TLS) instead of degrading to per-IP", () => {
    const value = "tls-cookie-value";
    const key = sessionRateLimitKey(req({ cookie: `__Secure-better-auth.session_token=${value}` }));
    expect(key).toBe(`cookie:${hash(value)}`);
  });

  it("prefers a UUID Bearer token over a session cookie when both are present", () => {
    const token = "40000000-0000-4000-8000-000000000002";
    const key = sessionRateLimitKey(
      req({ authorization: `Bearer ${token}`, cookie: "better-auth.session_token=ignored" })
    );
    expect(key).toBe(`bearer:${hash(token)}`);
  });

  it("falls back to the session cookie when the Bearer token is malformed but a cookie is present", () => {
    const value = "real-cookie";
    const key = sessionRateLimitKey(
      req({ authorization: "Bearer not-a-uuid", cookie: `better-auth.session_token=${value}` })
    );
    expect(key).toBe(`cookie:${hash(value)}`);
  });

  it("falls back to the per-IP namespace when no credential is presented", () => {
    expect(sessionRateLimitKey(req({ ip: "198.51.100.4" }))).toBe("ip:198.51.100.4");
  });

  it("falls back to per-IP for an empty Bearer value rather than minting an empty bucket", () => {
    expect(sessionRateLimitKey(req({ authorization: "Bearer ", ip: "198.51.100.9" }))).toBe(
      "ip:198.51.100.9"
    );
  });

  it("is stable for the same UUID credential and distinct across UUID credentials", () => {
    const a = sessionRateLimitKey(req({ authorization: `Bearer ${randomUUID()}` }));
    const a2Token = "40000000-0000-4000-8000-00000000000a";
    const a2 = sessionRateLimitKey(req({ authorization: `Bearer ${a2Token}` }));
    const a2again = sessionRateLimitKey(req({ authorization: `Bearer ${a2Token}` }));
    expect(a2).toBe(a2again);
    expect(a).not.toBe(a2);
  });

  it("does NOT accept an uppercase-hex UUID bearer — falls to per-IP, no distinct bucket (#319)", () => {
    // Better Auth mints lowercase UUIDs only; an uppercase-hex variant cannot resolve and
    // must not earn its own limiter bucket. Two different uppercased UUIDs (containing
    // a-f so toUpperCase actually changes them) from one peer collapse to the shared
    // ip:<peer> bucket, never to distinct bearer: hashes.
    const upperA = "abcdef01-0000-4000-8000-000000000001".toUpperCase();
    const upperB = "fedcba98-0000-4000-8000-000000000002".toUpperCase();
    const a = sessionRateLimitKey(req({ authorization: `Bearer ${upperA}`, ip: "198.51.100.40" }));
    const b = sessionRateLimitKey(req({ authorization: `Bearer ${upperB}`, ip: "198.51.100.40" }));
    expect(a).toBe("ip:198.51.100.40");
    expect(b).toBe("ip:198.51.100.40");
    expect(a).toBe(b);
    expect(a.startsWith("bearer:")).toBe(false);
  });
});

describe("mcpSessionRateLimitKey (jst_<uuid> MCP token policy)", () => {
  it("hashes a jst_<uuid> token into the distinct mcp namespace, never leaking the raw token", () => {
    const token = `jst_${randomUUID()}`;
    const key = mcpSessionRateLimitKey(req({ authorization: `Bearer ${token}` }));
    expect(key).toBe(`mcp:${hash(token)}`);
    expect(key).not.toContain(token);
    // MCP tokens must NOT collide with the session-bearer namespace.
    expect(key.startsWith("bearer:")).toBe(false);
  });

  it("falls back to the shared per-IP bucket for different malformed (non-jst) Bearer tokens", () => {
    const a = mcpSessionRateLimitKey(req({ authorization: "Bearer junk-1", ip: "198.51.100.20" }));
    const b = mcpSessionRateLimitKey(req({ authorization: "Bearer junk-2", ip: "198.51.100.20" }));
    expect(a).toBe("ip:198.51.100.20");
    expect(b).toBe("ip:198.51.100.20");
    expect(a).toBe(b);
  });

  it("falls back to per-IP for a jst_ prefix with a non-UUID suffix", () => {
    expect(
      mcpSessionRateLimitKey(req({ authorization: "Bearer jst_not-a-uuid", ip: "198.51.100.21" }))
    ).toBe("ip:198.51.100.21");
  });

  it("does NOT grant a UUID-only (session-shaped) bearer an MCP bucket", () => {
    // A bare session UUID is not an MCP token; it must not earn a per-principal mcp bucket.
    expect(
      mcpSessionRateLimitKey(
        req({ authorization: "Bearer 40000000-0000-4000-8000-000000000001", ip: "198.51.100.22" })
      )
    ).toBe("ip:198.51.100.22");
  });

  it("falls back to the per-IP namespace when no credential is presented", () => {
    expect(mcpSessionRateLimitKey(req({ ip: "198.51.100.23" }))).toBe("ip:198.51.100.23");
  });

  it("does NOT accept an uppercase `JST_<uuid>` bearer — falls to per-IP, no distinct bucket (#319)", () => {
    // MCP tokens are minted lowercase `jst_<uuid>`; the `tokens.verify()` Map lookup is
    // case-sensitive, so an uppercased variant always 401s and must NOT earn its own limiter
    // bucket. Both the `JST_` prefix AND the uppercase-hex UUID body must be rejected — two
    // different uppercased JST_ tokens from one peer collapse to ip:<peer>.
    const upperA = "jst_abcdef01-0000-4000-8000-000000000001".toUpperCase();
    const upperB = "jst_fedcba98-0000-4000-8000-000000000002".toUpperCase();
    const a = mcpSessionRateLimitKey(
      req({ authorization: `Bearer ${upperA}`, ip: "198.51.100.50" })
    );
    const b = mcpSessionRateLimitKey(
      req({ authorization: `Bearer ${upperB}`, ip: "198.51.100.50" })
    );
    expect(a).toBe("ip:198.51.100.50");
    expect(b).toBe("ip:198.51.100.50");
    expect(a).toBe(b);
    expect(a.startsWith("mcp:")).toBe(false);
  });
});
