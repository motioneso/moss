import { describe, expect, it } from "vitest";

import { resolveKeyring } from "@moss/db";
import {
  createPushSigningCipher,
  DEFAULT_VAPID_SUBJECT,
  PushSigningCipher,
  resolveVapidSubject
} from "@moss/notifications";

function makeEnv(secret: string): NodeJS.ProcessEnv {
  return {
    JARVIS_AI_SECRET_KEY: secret,
    JARVIS_AI_SECRET_KEY_ID: "v1"
  } as NodeJS.ProcessEnv;
}

describe("PushSigningCipher", () => {
  it("round-trips a VAPID private key through encrypt/decrypt", () => {
    const cipher = new PushSigningCipher(
      resolveKeyring(
        "JARVIS_AI_SECRET_KEY",
        "JARVIS_AI_SECRET_KEY_ID",
        "JARVIS_AI_SECRET_KEYS",
        "unused-dev-default",
        makeEnv("test-secret-one")
      )
    );

    const envelope = cipher.encryptJson({ privateKey: "a-fake-vapid-private-key" });
    const decrypted = cipher.decryptJson(envelope);

    expect(decrypted.privateKey).toBe("a-fake-vapid-private-key");
  });

  it("fails to decrypt with a different key (proves the ciphertext is actually bound to the key)", () => {
    const cipherA = new PushSigningCipher(
      resolveKeyring(
        "JARVIS_AI_SECRET_KEY",
        "JARVIS_AI_SECRET_KEY_ID",
        "JARVIS_AI_SECRET_KEYS",
        "unused-dev-default",
        makeEnv("secret-a")
      )
    );
    const cipherB = new PushSigningCipher(
      resolveKeyring(
        "JARVIS_AI_SECRET_KEY",
        "JARVIS_AI_SECRET_KEY_ID",
        "JARVIS_AI_SECRET_KEYS",
        "unused-dev-default",
        makeEnv("secret-b")
      )
    );

    const envelope = cipherA.encryptJson({ privateKey: "a-fake-vapid-private-key" });

    expect(() => cipherB.decryptJson(envelope)).toThrow();
  });
});

describe("createPushSigningCipher", () => {
  it("reuses the existing JARVIS_AI_SECRET_KEY* env vars rather than a push-specific one", () => {
    // #743 / #2227 design decision: no new required env var (Ben's 2026-09-01 ruling).
    const cipher = createPushSigningCipher(makeEnv("shared-ai-secret"));
    const envelope = cipher.encryptJson({ privateKey: "shared-key-round-trip" });
    expect(cipher.decryptJson(envelope).privateKey).toBe("shared-key-round-trip");
  });
});

// #743 security finding 5: the VAPID subject is configuration-derived. A request's Host
// header must never become the identity the instance presents to push services.
describe("resolveVapidSubject", () => {
  it("falls back to the fixed mailto contact when no public base URL is configured", () => {
    expect(resolveVapidSubject({} as NodeJS.ProcessEnv)).toBe(DEFAULT_VAPID_SUBJECT);
    expect(DEFAULT_VAPID_SUBJECT).toBe("mailto:push@jarv1s.local");
  });

  it("uses only the https origin of the configured public base URL", () => {
    const env = { JARVIS_PUBLIC_BASE_URL: "https://moss.example.com/app/?x=1#f" } as NodeJS.ProcessEnv;
    expect(resolveVapidSubject(env)).toBe("https://moss.example.com");
  });

  it("honours the MOSS_ spelling of the setting", () => {
    const env = { MOSS_PUBLIC_BASE_URL: "https://moss.example.org" } as NodeJS.ProcessEnv;
    expect(resolveVapidSubject(env)).toBe("https://moss.example.org");
  });

  it.each([
    ["http://moss.example.com", "an http URL"],
    ["not a url", "a malformed value"],
    ["https://user:pw@moss.example.com", "a URL carrying credentials"],
    ["mailto:someone@example.com", "a non-https scheme"],
    ["", "an empty value"]
  ])("ignores %s (%s) and uses the fixed contact", (value) => {
    const env = { JARVIS_PUBLIC_BASE_URL: value } as NodeJS.ProcessEnv;
    expect(resolveVapidSubject(env)).toBe(DEFAULT_VAPID_SUBJECT);
  });
});
