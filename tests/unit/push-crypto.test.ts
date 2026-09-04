import { describe, expect, it } from "vitest";

import { resolveKeyring } from "@moss/db";
import { createPushSigningCipher, PushSigningCipher } from "@moss/notifications";

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
