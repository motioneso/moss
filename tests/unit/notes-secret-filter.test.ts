import { describe, expect, it } from "vitest";

import { isCredentialShaped } from "../../packages/chat/src/live/notes-secret-filter.js";

const CREDENTIAL_SHAPED: readonly [string, string][] = [
  [
    "PEM private key block",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----"
  ],
  ["password assignment with colon", "password: hunter2foo"],
  ["password assignment with equals", "password = SuperSecret123"],
  [
    "Authorization header with Bearer token",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123"
  ],
  ["bare Bearer token", "curl -H 'Bearer fake-token-value'"],
  [
    "env-var assignment with SECRET_KEY in the name",
    "STRIPE_SECRET_KEY=definitely-not-a-real-secret"
  ],
  [
    "api_key keyword adjacent to a long hex run",
    "api_key: 4f3c2b1a9e8d7c6b5a4938271605f4e3d2c1b0a"
  ],
  [
    "secret keyword adjacent to a long base64 run",
    "secret=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo1Njc4"
  ],
  ["canonical guard: standalone secret language", "keep it a secret between us"],
  ["canonical guard: password language", "my password is weak, I should change it"],
  ["canonical guard: api_key language", "the api_key field in the config schema"]
];

const NOT_CREDENTIAL_SHAPED: readonly [string, string][] = [
  ["plain note text", "buy milk and eggs tomorrow"],
  ["meeting notes", "meeting notes: discuss Q3 roadmap"],
  ["token mentioned with no adjacent long run", "TOKEN of appreciation for your hard work"],
  ["unrelated env assignment", "DEBUG=true"],
  ["empty string", ""]
];

describe("isCredentialShaped", () => {
  it.each(CREDENTIAL_SHAPED)("flags %s", (_label, text) => {
    expect(isCredentialShaped(text)).toBe(true);
  });

  it.each(NOT_CREDENTIAL_SHAPED)("does not flag %s", (_label, text) => {
    expect(isCredentialShaped(text)).toBe(false);
  });

  it("includes provider-token shapes covered by the canonical memory guard", () => {
    const providerTokenShape = ["g", "hp_", "not-a-real-credential"].join("");

    expect(isCredentialShaped(providerTokenShape)).toBe(true);
  });
});
