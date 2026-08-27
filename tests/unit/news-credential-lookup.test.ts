import { describe, expect, it } from "vitest";

import type { DataContextDb, EncryptedSecret } from "@moss/db";

import {
  createNewsCredentialLookup,
  type NewsCredentialEnvelopeReader
} from "../../packages/news/src/source/credential-lookup.js";
import type { NewsCredentialCipherPort } from "../../packages/news/src/credential-cipher-port.js";

const PLAINTEXT_KEY = "the-persons-own-key";
const CIPHER_DETAIL = "keyring entry news-2026 is missing";

const ENVELOPE: EncryptedSecret = {
  version: 1,
  algorithm: "aes-256-gcm",
  iv: "aXY=",
  tag: "dGFn",
  ciphertext: "Y2lwaGVy"
};

/** Stands in for a request-scoped database handle; the lookup only passes it through. */
const SCOPED_DB = { db: {} } as unknown as DataContextDb;

function reader(
  result:
    | {
        readonly status: "configured";
        readonly envelope: EncryptedSecret;
        readonly generation: string;
      }
    | { readonly status: "revoked" }
    | null
): NewsCredentialEnvelopeReader & { calls: Array<{ sourceId: string }> } {
  const calls: Array<{ sourceId: string }> = [];
  return {
    calls,
    async readCredentialForUse(_scopedDb: DataContextDb, sourceId: string) {
      calls.push({ sourceId });
      return result;
    }
  };
}

function cipher(behaviour: "ok" | "throws" | "empty"): NewsCredentialCipherPort {
  return {
    encrypt: () => ENVELOPE,
    decrypt: () => {
      if (behaviour === "throws") throw new Error(CIPHER_DETAIL);
      return { apiKey: behaviour === "empty" ? "" : PLAINTEXT_KEY };
    }
  };
}

function lookupWith(
  readerResult: Parameters<typeof reader>[0],
  cipherBehaviour: "ok" | "throws" | "empty" = "ok"
) {
  const envelopeReader = reader(readerResult);
  const port = createNewsCredentialLookup({
    reader: envelopeReader,
    cipher: cipher(cipherBehaviour)
  });
  return {
    envelopeReader,
    call: () => port({ actorUserId: "user-1", sourceId: "source-1", credentialContext: SCOPED_DB })
  };
}

describe("news credential lookup", () => {
  it("reports a missing key when the person has no row for the source", async () => {
    const result = await lookupWith(null).call();
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("reports a revoked key when the row has been revoked", async () => {
    const result = await lookupWith({ status: "revoked" }).call();
    expect(result).toEqual({ ok: false, reason: "revoked" });
  });

  it("returns the decrypted key and the generation when the row is usable", async () => {
    const result = await lookupWith({
      status: "configured",
      envelope: ENVELOPE,
      generation: "4"
    }).call();

    expect(result).toEqual({ ok: true, apiKey: PLAINTEXT_KEY, generation: "4" });
  });

  it("carries the generation through as text so it can key a cache", async () => {
    const result = await lookupWith({
      status: "configured",
      envelope: ENVELOPE,
      generation: "12"
    }).call();

    expect(result).toMatchObject({ ok: true, generation: "12" });
    expect(typeof (result as { generation: string }).generation).toBe("string");
  });

  it("reports an unreadable key when decryption fails, and says nothing about why", async () => {
    const result = await lookupWith(
      { status: "configured", envelope: ENVELOPE, generation: "1" },
      "throws"
    ).call();

    expect(result).toEqual({ ok: false, reason: "unreadable" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CIPHER_DETAIL);
    expect(serialized).not.toContain("keyring");
    expect(serialized).not.toContain(PLAINTEXT_KEY);
  });

  it("reports an unreadable key when decryption produces an empty key", async () => {
    const result = await lookupWith(
      { status: "configured", envelope: ENVELOPE, generation: "1" },
      "empty"
    ).call();

    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });

  it("returns the plaintext key only in the success value, never on a failure", async () => {
    const failures = await Promise.all([
      lookupWith(null).call(),
      lookupWith({ status: "revoked" }).call(),
      lookupWith({ status: "configured", envelope: ENVELOPE, generation: "1" }, "throws").call()
    ]);

    for (const failure of failures) {
      expect(JSON.stringify(failure)).not.toContain(PLAINTEXT_KEY);
      expect(Object.keys(failure)).toEqual(["ok", "reason"]);
    }
  });

  it("asks the reader for the source it was given", async () => {
    const { envelopeReader, call } = lookupWith({
      status: "configured",
      envelope: ENVELOPE,
      generation: "1"
    });
    await call();

    expect(envelopeReader.calls).toEqual([{ sourceId: "source-1" }]);
  });
});
