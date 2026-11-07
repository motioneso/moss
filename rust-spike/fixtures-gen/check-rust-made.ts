/**
 * Checks the values `portability/tests/rust_made.rs` wrote with the app's own code: Rust's
 * password hashes verify, and Rust's envelopes and family key store decrypt.
 *
 *   pnpm exec tsx rust-spike/fixtures-gen/check-rust-made.ts <path to rust-made.json>
 */
import { deepStrictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createAiSecretCipher } from "@moss/ai";
import { createConnectorSecretCipher } from "@moss/connectors";
import type { JsonSecretCipher, Keyring } from "@moss/db";
import { createIntegrationsCipherFromKeyring } from "@moss/integrations";
import { INTEGRATIONS_FAMILY, invalidateFamilyKeyCache, loadFamilyKeyring } from "@moss/settings";

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(spikeRoot, "..");

type Text = { text: string } | { utf16: number[] };
type Sealed = { envelope: unknown; payload: Record<string, unknown> };

const fromText = (value: Text): string =>
  "text" in value ? value.text : String.fromCharCode(...value.utf16);

const rustMadePath = process.argv[2];
if (!rustMadePath) throw new Error("usage: check-rust-made.ts <path to rust-made.json>");
const rustMade = JSON.parse(await readFile(rustMadePath, "utf8")) as {
  passwords: { label: string; password: Text; hash: string }[];
  envelopes: { cipher: "ai" | "connector"; sealed: Sealed }[];
  family: {
    underAppStore: Sealed;
    rustSetting: Record<string, unknown>;
    rustCurrentKeyId: string;
    underRustStore: Sealed;
  };
};
const secrets = JSON.parse(await readFile(join(spikeRoot, "fixtures/secrets.json"), "utf8")) as {
  keyrings: Record<"ai" | "connector", { env: Record<string, string> }>;
  family: {
    storedSetting: Record<string, unknown>;
    cases: { label: string; envelope: unknown; expect: { ok?: true; value?: string } }[];
  };
};

const failures: string[] = [];
async function check(label: string, run: () => unknown): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const opens = (cipher: JsonSecretCipher, sealed: Sealed) =>
  deepStrictEqual(cipher.decryptJson(cipher.parseEnvelope(sealed.envelope)), sealed.payload);

// Passwords, through the better-auth function the app's sign-in uses.
const authRequire = createRequire(join(repoRoot, "packages/auth/package.json"));
const { verifyPassword } = (await import(
  pathToFileURL(authRequire.resolve("better-auth/crypto")).href
)) as { verifyPassword(input: { hash: string; password: string }): Promise<boolean> };
for (const entry of rustMade.passwords) {
  const password = fromText(entry.password);
  await check(`password ${entry.label}`, async () => {
    deepStrictEqual(await verifyPassword({ hash: entry.hash, password }), true);
    deepStrictEqual(await verifyPassword({ hash: entry.hash, password: `${password}!` }), false);
  });
}

// AI and connector envelopes.
const ciphers = {
  ai: createAiSecretCipher(secrets.keyrings.ai.env),
  connector: createConnectorSecretCipher(secrets.keyrings.connector.env)
};
for (const [index, entry] of rustMade.envelopes.entries()) {
  await check(`envelope ${index} (${entry.cipher})`, () =>
    opens(ciphers[entry.cipher], entry.sealed)
  );
}

// Family keys, read by the app's loader from an in-memory settings table.
const settings = new Map<string, Record<string, unknown>>();
const fakeDb = {
  db: {
    selectFrom: () => ({
      select: () => ({
        where: (_column: string, _op: string, key: string) => ({
          executeTakeFirst: async () =>
            settings.has(key) ? { value: settings.get(key) } : undefined
        })
      })
    })
  }
} as unknown as Parameters<typeof loadFamilyKeyring>[0];
async function familyKeys(
  setting: Record<string, unknown>
): Promise<{ keyring: Keyring; cipher: JsonSecretCipher }> {
  settings.set(INTEGRATIONS_FAMILY.settingKey, setting);
  invalidateFamilyKeyCache(INTEGRATIONS_FAMILY);
  const keyring = await loadFamilyKeyring(fakeDb, INTEGRATIONS_FAMILY, secrets.keyrings.ai.env);
  if (!keyring) throw new Error("the app found no family key in the store");
  return { keyring, cipher: createIntegrationsCipherFromKeyring(keyring) };
}

await check("family: Rust credential under the app's store", async () =>
  opens((await familyKeys(secrets.family.storedSetting)).cipher, rustMade.family.underAppStore)
);
await check("family: Rust-written store", async () => {
  const { keyring, cipher } = await familyKeys(rustMade.family.rustSetting);
  deepStrictEqual(keyring.currentKeyId, rustMade.family.rustCurrentKeyId);
  opens(cipher, rustMade.family.underRustStore);
  // The app's own envelopes still open, through the keys Rust carried over as retired.
  for (const entry of secrets.family.cases.filter((c) => c.expect.ok)) {
    const value = cipher.decryptJson(cipher.parseEnvelope(entry.envelope));
    deepStrictEqual(
      Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
      entry.expect.value
    );
  }
});

const total = rustMade.passwords.length + rustMade.envelopes.length + 2;
console.log(
  `rust-made: ${total - failures.length}/${total} checks pass in the app's code ` +
    `(${rustMade.passwords.length} password hashes, ${rustMade.envelopes.length} envelopes, ` +
    `2 family key checks)`
);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
