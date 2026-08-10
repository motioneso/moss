import { describe, expect, it } from "vitest";

import { redactExact, redactSecrets } from "../../packages/ai/src/adapters/redact.js";

describe("redactSecrets", () => {
  it("returns an empty string for undefined/empty input", () => {
    expect(redactSecrets(undefined)).toBe("");
    expect(redactSecrets("")).toBe("");
  });

  it("redacts a JARVIS_MCP_TOKEN=<value> env-var prefix", () => {
    const out = redactSecrets("cmd failed: JARVIS_MCP_TOKEN=jst_abc123XYZ codex --sandbox");
    expect(out).not.toContain("jst_abc123XYZ");
    expect(out).not.toContain("JARVIS_MCP_TOKEN=jst_");
    expect(out).toContain("[redacted]");
    // Non-secret context is preserved.
    expect(out).toContain("codex --sandbox");
  });

  it("redacts an Authorization Bearer header value", () => {
    const out = redactSecrets("header Authorization: Bearer jst_tok-en_value");
    expect(out).not.toContain("jst_tok-en_value");
    expect(out).not.toMatch(/Bearer\s+jst_/);
    expect(out).toContain("[redacted]");
  });

  it("redacts a bare jst_ session token anywhere it appears", () => {
    const out = redactSecrets("token jst_deadbeefCAFE0123 leaked into stderr");
    expect(out).not.toContain("jst_deadbeefCAFE0123");
    expect(out).toContain("[redacted]");
    expect(out).toContain("leaked into stderr");
  });

  it("leaves non-secret text untouched", () => {
    const clean = "tmux new-session failed (code 1): duplicate session name";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe("redactExact (#342 Phase 3 login-contract §L.6.3)", () => {
  it("scrubs the EXACT literal secret that redactSecrets' shape patterns would MISS", () => {
    const code = "AUTHCODE-9f8e7d6c5b4a"; // an arbitrary OAuth code — not a jst_/Bearer shape
    expect(redactSecrets(`provider rejected ${code}`)).toContain(code); // shape patterns miss it
    const out = redactExact(`provider rejected ${code} as invalid`, code);
    expect(out).not.toContain(code);
    expect(out).toContain("[redacted]");
    expect(out).toContain("provider rejected");
  });

  it("scrubs EVERY occurrence and handles regex-special characters in the secret", () => {
    const code = "a.b*c+d?(e)"; // regex metacharacters must be escaped, not interpreted
    const out = redactExact(`${code} and again ${code}`, code);
    expect(out).toBe("[redacted] and again [redacted]");
  });

  it("is a no-op for empty/undefined input or a too-short secret (avoids over-redaction)", () => {
    expect(redactExact(undefined, "secret")).toBe("");
    expect(redactExact("text", undefined)).toBe("text");
    expect(redactExact("the cat sat", "cat")).toBe("the cat sat"); // < 4 chars ⇒ not treated as a secret
  });
});
