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

describe("redactSecrets widened shapes (issue 2381 review round 1)", () => {
  it("redacts a database URL with the password in it", () => {
    const out = redactSecrets("postgres://admin:s3cr3t-pw-db9@db.internal:5432/app");
    expect(out).not.toContain("s3cr3t-pw-db9");
    expect(out).toContain("[redacted]");
  });

  it("redacts a plain password assignment", () => {
    const out = redactSecrets("password=hunter2-hunter2");
    expect(out).not.toContain("hunter2-hunter2");
    expect(out).toContain("[redacted]");
  });

  it("redacts generic secret and key assignments but keeps the name", () => {
    for (const line of [
      "OPENAI_API_KEY=sk-proj-AbC123xYz456",
      "ANTHROPIC_API_KEY=sk-ant-api03-abcDEF123",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI K7MDENG bPxRfiCY",
      "STRIPE_SECRET_KEY=sk_live_abc123",
      "api_secret=Zx9q2-SECRET-99"
    ]) {
      const out = redactSecrets(line);
      expect(out).not.toContain(line.split("=")[1]);
      expect(out).toContain("[redacted]");
    }
  });

  it("redacts vendor token prefixes", () => {
    for (const token of ["ghp_abcDEF1234567890abcd", "xoxb-12345-abcde", "AKIAIOSFODNN7EXAMPLE"]) {
      const out = redactSecrets(`saw ${token} here`);
      expect(out).not.toContain(token);
      expect(out).toContain("[redacted]");
    }
  });

  it("redacts a private key block", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogusKey\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`config:\n${key}\ndone`);
    expect(out).not.toContain("MIIBogusKey");
    expect(out).toContain("[redacted]");
    expect(out).toContain("done");
  });

  it("still misses an arbitrary pasted sign-in code, which is the documented limit", () => {
    const code = "4/1AbC-xyz-7890-qrs";
    // Shape matching cannot see this: no marker, no assignment. The literal
    // scrub is the backstop for values we already hold.
    expect(redactSecrets(`provider rejected ${code}`)).toContain(code);
    expect(redactExact(`provider rejected ${code}`, code)).not.toContain(code);
  });
});
