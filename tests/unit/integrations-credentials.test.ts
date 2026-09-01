import { describe, expect, it } from "vitest";
import { applyCredential, createIntegrationsCipher } from "@moss/integrations";
import type { CredentialPlacement } from "@moss/shared";

describe("integration credentials", () => {
  it("encrypts and decrypts round-trip with the dev keyring", () => {
    const cipher = createIntegrationsCipher({});
    const envelope = cipher.encryptJson({ secret: "tok-123" });
    expect(JSON.stringify(envelope)).not.toContain("tok-123");
    expect(cipher.decryptJson(cipher.parseEnvelope(envelope))).toEqual({ secret: "tok-123" });
  });

  it("renders bearer, named header, and query placements", () => {
    const cases: { placement: CredentialPlacement; header: [string, string] }[] = [
      { placement: { kind: "bearer" as const }, header: ["authorization", "Bearer tok"] },
      { placement: { kind: "header" as const, name: "X-Api-Key" }, header: ["x-api-key", "tok"] }
    ];
    for (const c of cases) {
      const url = new URL("https://svc.local/api");
      const headers = new Headers();
      applyCredential(c.placement, "tok", url, headers);
      expect(headers.get(c.header[0])).toBe(c.header[1]);
    }
    const url = new URL("https://svc.local/api");
    applyCredential({ kind: "query", name: "apikey" }, "tok", url, new Headers());
    expect(url.searchParams.get("apikey")).toBe("tok");
  });

  it("does nothing without a secret", () => {
    const url = new URL("https://svc.local/api");
    const headers = new Headers();
    applyCredential({ kind: "bearer" }, null, url, headers);
    expect([...headers.keys()]).toEqual([]);
  });
});
