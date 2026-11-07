/**
 * Throwaway fixture generator for the Rust Phase 0a spike (JS-34).
 *
 * Runs the app's own TypeScript code and records what it produces, so the Rust tests compare
 * against real behaviour rather than a re-implementation. Every password and key here is a
 * made-up fixture value. No database is touched.
 *
 * Run from the repo root:
 *   pnpm exec tsx rust-spike/fixtures-gen/generate.ts
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createAiSecretCipher } from "@moss/ai";
import { hashPassword } from "@moss/auth";
import { createConnectorSecretCipher } from "@moss/connectors";
import {
  assertUniqueMigrationVersions,
  JsonSecretCipher,
  loadMigrationFiles,
  loadModuleMigrationFiles,
  resolveKeyring,
  type EncryptedSecret,
  type Keyring
} from "@moss/db";
import { createIntegrationsCipherFromKeyring } from "@moss/integrations";
import { getBuiltInSqlMigrationDirectories } from "@moss/module-registry";
import {
  generateFamilyKey,
  INTEGRATIONS_FAMILY,
  invalidateFamilyKeyCache,
  loadFamilyKeyring,
  rotateFamilyKey
} from "@moss/settings";

import { LEGACY_UPGRADE_SHIMS } from "../../packages/db/src/migrations/legacy-upgrade-shims.js";

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(spikeRoot, "..");
const fixturesDir = join(spikeRoot, "fixtures");

type Outcome = { readonly ok: true; readonly value: unknown } | { readonly error: string };

async function outcome(run: () => unknown): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A plain string when well formed; UTF-16 code units when a lone surrogate would break JSON readers. */
function text(value: string): { text: string } | { utf16: number[] } {
  return !/\p{Cs}/u.test(value)
    ? { text: value }
    : { utf16: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)) };
}

/** JSON text as UTF-8 bytes. Lone surrogates become U+FFFD, exactly as Node encodes them on use. */
function jsonUtf8Base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function provenance(): Record<string, string> {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  return { commit, node: process.versions.node, unicode: process.versions.unicode ?? "unknown" };
}

// ---------------------------------------------------------------------------------------------
// Fact 1: password hashes
// ---------------------------------------------------------------------------------------------

async function passwordFixtures(): Promise<unknown> {
  const authRequire = createRequire(join(repoRoot, "packages/auth/package.json"));
  const betterAuthCrypto = (await import(
    pathToFileURL(authRequire.resolve("better-auth/crypto")).href
  )) as { verifyPassword(input: { hash: string; password: string }): Promise<boolean> };
  const verify = (hash: string, password: string) =>
    outcome(() => betterAuthCrypto.verifyPassword({ hash, password }));

  const cases: { label: string; password: string }[] = [
    { label: "ascii", password: "correct horse battery staple" },
    { label: "empty", password: "" },
    { label: "colons", password: "pass:word:with:colons" },
    { label: "nfkc-ligatures", password: "ﬁnance-ﬂow" },
    { label: "nfkc-fullwidth", password: "ＡＢＣ１２３" },
    { label: "nfc-composed", password: "café crème" },
    { label: "nfd-decomposed", password: "café crème" },
    { label: "emoji", password: "\u{1f510} moss \u{1f33f}" },
    { label: "cjk", password: "密码测试" },
    { label: "long", password: "x".repeat(1000) },
    { label: "lone-surrogate", password: "\ud800abc" }
  ];

  const hashes = [];
  const byLabel = new Map<string, { password: string; hash: string }>();
  for (const entry of cases) {
    const hash = await hashPassword(entry.password);
    byLabel.set(entry.label, { password: entry.password, hash });
    hashes.push({
      label: entry.label,
      password: text(entry.password),
      hash,
      expect: await verify(hash, entry.password)
    });
  }

  // Other inputs checked against the stored hashes above.
  const crossChecks: { label: string; hashOf: string; input: string }[] = [
    { label: "wrong-password", hashOf: "ascii", input: "correct horse battery stapler" },
    { label: "empty-against-ascii", hashOf: "ascii", input: "" },
    { label: "decomposed-input-composed-hash", hashOf: "nfc-composed", input: "café crème" },
    { label: "expanded-ligatures", hashOf: "nfkc-ligatures", input: "finance-flow" },
    { label: "ascii-for-fullwidth", hashOf: "nfkc-fullwidth", input: "ABC123" },
    { label: "replacement-for-lone-surrogate", hashOf: "lone-surrogate", input: "�abc" },
    { label: "case-changed", hashOf: "ascii", input: "Correct horse battery staple" }
  ];
  const checks = [];
  for (const check of crossChecks) {
    const stored = byLabel.get(check.hashOf)!;
    checks.push({
      label: check.label,
      hash: stored.hash,
      input: text(check.input),
      expect: await verify(stored.hash, check.input)
    });
  }

  // Altered stored hashes, verified with the right password.
  const ascii = byLabel.get("ascii")!;
  const [salt, key] = ascii.hash.split(":") as [string, string];
  const altered: { label: string; hash: string }[] = [
    { label: "no-colon", hash: `${salt}${key}` },
    { label: "empty-salt", hash: `:${key}` },
    { label: "empty-key", hash: `${salt}:` },
    { label: "empty-string", hash: "" },
    { label: "extra-field", hash: `${ascii.hash}:extra` },
    { label: "uppercase-key", hash: `${salt}:${key.toUpperCase()}` },
    { label: "uppercase-salt", hash: `${salt.toUpperCase()}:${key}` },
    { label: "short-key", hash: `${salt}:${key.slice(0, 64)}` }
  ];
  const malformed = [];
  for (const entry of altered) {
    malformed.push({
      label: entry.label,
      hash: entry.hash,
      input: text(ascii.password),
      expect: await verify(entry.hash, ascii.password)
    });
  }

  return { provenance: provenance(), hashes, checks, malformed, nfkcTable: nfkcTable() };
}

/**
 * One digest per block of code points over "<hex code point>=<NFKC of it>\n" lines, so the
 * Rust side can check its normalization table against this Node's for every code point.
 *
 * `unassigned` lists the code points this Node's Unicode version has not assigned, as hex
 * ranges. Node leaves them unchanged, and a Rust table from a later Unicode version may not.
 */
function nfkcTable(): { blockSize: number; digests: string[]; unassigned: string } {
  const blockSize = 0x1000;
  const digests: string[] = [];
  const ranges: string[] = [];
  let rangeStart = -1;
  for (let start = 0; start < 0x110000; start += blockSize) {
    const hash = createHash("sha256");
    for (let codePoint = start; codePoint < start + blockSize; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const text = String.fromCodePoint(codePoint);
      const unassigned = /\p{Cn}/u.test(text);
      if (unassigned && rangeStart < 0) rangeStart = codePoint;
      if (!unassigned && rangeStart >= 0) {
        ranges.push(`${rangeStart.toString(16)}-${(codePoint - 1).toString(16)}`);
        rangeStart = -1;
      }
      hash.update(`${codePoint.toString(16)}=${text.normalize("NFKC")}\n`);
    }
    digests.push(hash.digest("hex").slice(0, 16));
  }
  if (rangeStart >= 0) ranges.push(`${rangeStart.toString(16)}-10ffff`);
  return { blockSize, digests, unassigned: ranges.join(",") };
}

// ---------------------------------------------------------------------------------------------
// Fact 2: AES-256-GCM credential envelopes
// ---------------------------------------------------------------------------------------------

const AI_KEY_ONE = "fixture-only-ai-key-one-not-a-real-secret-000001";
const AI_KEY_TWO = "fixture-only-ai-key-two-not-a-real-secret-000002";
const AI_KEY_SEVEN = "fixture-only-ai-key-seven-not-a-real-secret-0007";
const AI_KEY_ZERO = "fixture-only-ai-key-zero-not-a-real-secret-00000";
const UNRELATED_KEY = "fixture-only-unrelated-key-not-a-real-secret-999";
const CONNECTOR_KEY = "fixture-only-connector-key-not-a-real-secret-0001";
const INTEGRATIONS_ENV_KEY = "fixture-only-integrations-env-key-not-real-00001";

const aiBeforeRotation = {
  NODE_ENV: "production",
  JARVIS_AI_SECRET_KEY: AI_KEY_ONE,
  JARVIS_AI_SECRET_KEY_ID: "k1"
};
// The retired list is written with "7" in the middle. Object.entries puts integer-like keys first.
const aiAfterRotation = {
  NODE_ENV: "production",
  JARVIS_AI_SECRET_KEY: AI_KEY_TWO,
  JARVIS_AI_SECRET_KEY_ID: "k2",
  JARVIS_AI_SECRET_KEYS: `{"k1":"${AI_KEY_ONE}","7":"${AI_KEY_SEVEN}","k0":"${AI_KEY_ZERO}"}`
};
// The MOSS_ name wins over the JARVIS_ name.
const connectorEnv = {
  NODE_ENV: "production",
  MOSS_CONNECTOR_SECRET_KEY: CONNECTOR_KEY,
  JARVIS_CONNECTOR_SECRET_KEY: "fixture-only-ignored-jarvis-name-not-a-real-secret"
};

function fingerprints(keyring: Keyring): string[] {
  return keyring.legacyCandidates.map((key) =>
    createHash("sha256").update(key).digest("hex").slice(0, 16)
  );
}

function withoutKeyId(envelope: EncryptedSecret): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...envelope };
  delete copy.keyId;
  return copy;
}

function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  bytes[0] = bytes[0]! ^ 0x01;
  return bytes.toString("base64");
}

async function secretFixtures(): Promise<unknown> {
  const before = createAiSecretCipher(aiBeforeRotation);
  const after = createAiSecretCipher(aiAfterRotation);
  const unrelated = new JsonSecretCipher(
    resolveKeyring("K", "K_ID", "K_KEYS", "", {
      NODE_ENV: "production",
      K: UNRELATED_KEY,
      K_ID: "k2"
    }),
    "AI secret"
  );
  const payload = {
    apiKey: "sk-fixture-only-not-real",
    nested: { count: 3, list: [1, 2.5, "three"], flag: true, none: null },
    unicode: "π \u{1f33f} café",
    "10": "integer-like key"
  };

  const current = after.encryptJson(payload);
  const retired = before.encryptJson(payload);
  const reencode = (value: string, how: "unpadded" | "urlsafe" | "spaced" | "junk") => {
    if (how === "unpadded") return value.replace(/=+$/, "");
    if (how === "urlsafe") return value.replace(/\+/g, "-").replace(/\//g, "_");
    if (how === "spaced") return value.replace(/(.{4})/g, "$1\n ");
    return `${value.slice(0, 2)}$${value.slice(2)}${value.endsWith("=") ? "junk" : "=junk"}`;
  };
  const variant = (how: "unpadded" | "urlsafe" | "spaced" | "junk") => ({
    ...current,
    iv: reencode(current.iv, how),
    tag: reencode(current.tag, how),
    ciphertext: reencode(current.ciphertext, how)
  });

  // Hand-made envelopes the app never writes, recorded only to show how strict each side is.
  const handMade = (ivLength: number, tagLength: number) => {
    const keyring = resolveKeyring(
      "JARVIS_AI_SECRET_KEY",
      "JARVIS_AI_SECRET_KEY_ID",
      "JARVIS_AI_SECRET_KEYS",
      "fixture-only-dev-default",
      aiAfterRotation
    );
    const iv = Buffer.alloc(ivLength, 7);
    const cipher = createCipheriv("aes-256-gcm", keyring.keys.get("k2")!, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final()
    ]);
    return {
      version: 1,
      algorithm: "aes-256-gcm",
      keyId: "k2",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().subarray(0, tagLength).toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  };

  const aiCases: { label: string; envelope?: unknown; envelopeText?: string; note?: string }[] = [
    { label: "current-key", envelope: current },
    { label: "retired-key", envelope: retired },
    { label: "legacy-no-id-current", envelope: withoutKeyId(current) },
    { label: "legacy-no-id-retired", envelope: withoutKeyId(retired) },
    { label: "legacy-no-id-no-match", envelope: withoutKeyId(unrelated.encryptJson(payload)) },
    { label: "wrong-key-same-id", envelope: unrelated.encryptJson(payload) },
    { label: "tampered-tag", envelope: { ...current, tag: flipFirstByte(current.tag) } },
    {
      label: "tampered-ciphertext",
      envelope: { ...current, ciphertext: flipFirstByte(current.ciphertext) }
    },
    { label: "unknown-key-id", envelope: { ...current, keyId: "k9" } },
    { label: "empty-key-id", envelope: { ...current, keyId: "" } },
    {
      label: "array-payload",
      envelope: after.encryptJson(["a"] as unknown as Record<string, unknown>)
    },
    {
      label: "null-payload",
      envelope: after.encryptJson(null as unknown as Record<string, unknown>)
    },
    { label: "lone-surrogate-payload", envelope: after.encryptJson({ value: "a\ud800b" }) },
    { label: "base64-unpadded", envelope: variant("unpadded") },
    { label: "base64-urlsafe", envelope: variant("urlsafe") },
    { label: "base64-whitespace", envelope: variant("spaced") },
    { label: "base64-junk", envelope: variant("junk") },
    {
      // U+0100 + c: the same low byte as the ASCII letter it replaces.
      label: "base64-non-ascii",
      envelope: {
        ...current,
        iv: String.fromCharCode(0x100 | current.iv.charCodeAt(0)) + current.iv.slice(1)
      }
    },
    {
      label: "version-as-float",
      envelopeText: JSON.stringify(current).replace('"version":1', '"version":1.0')
    },
    { label: "malformed-array", envelope: [current] },
    { label: "malformed-version-2", envelope: { ...current, version: 2 } },
    { label: "malformed-algorithm", envelope: { ...current, algorithm: "aes-128-gcm" } },
    { label: "malformed-key-id-number", envelope: { ...current, keyId: 5 } },
    { label: "malformed-empty-iv", envelope: { ...current, iv: "" } },
    { label: "hand-made-16-byte-iv", envelope: handMade(16, 16), note: "never written by the app" },
    { label: "hand-made-12-byte-tag", envelope: handMade(12, 12), note: "never written by the app" }
  ];

  const decryptWith = (cipher: JsonSecretCipher, envelope: unknown) =>
    outcome(() => jsonUtf8Base64(cipher.decryptJson(cipher.parseEnvelope(envelope))));

  const cases = [];
  for (const entry of aiCases) {
    const envelope = entry.envelopeText ? JSON.parse(entry.envelopeText) : entry.envelope;
    cases.push({
      label: entry.label,
      keyring: "ai",
      cipherLabel: "AI secret",
      ...(entry.envelopeText ? { envelopeText: entry.envelopeText } : { envelope }),
      ...(entry.note ? { note: entry.note } : {}),
      expect: await decryptWith(after, envelope)
    });
  }

  const connector = createConnectorSecretCipher(connectorEnv);
  const connectorEnvelope = connector.encryptJson({ refreshToken: "fixture-only-refresh" });
  cases.push({
    label: "connector-moss-name",
    keyring: "connector",
    cipherLabel: "connector secret",
    envelope: connectorEnvelope,
    expect: await decryptWith(connector, connectorEnvelope)
  });

  const keyringErrors = [];
  const errorEnvs: { label: string; env: Record<string, string> }[] = [
    { label: "missing-in-production", env: { NODE_ENV: "production" } },
    {
      label: "short-in-production",
      env: { NODE_ENV: "production", JARVIS_AI_SECRET_KEY: "short" }
    },
    {
      label: "keys-not-object",
      env: { ...aiAfterRotation, JARVIS_AI_SECRET_KEYS: JSON.stringify(["x"]) }
    },
    {
      label: "keys-empty-entry",
      env: { ...aiAfterRotation, JARVIS_AI_SECRET_KEYS: JSON.stringify({ k1: "" }) }
    },
    { label: "keys-bad-json", env: { ...aiAfterRotation, JARVIS_AI_SECRET_KEYS: "{not json" } },
    { label: "staging-is-hardened", env: { NODE_ENV: "staging", JARVIS_AI_SECRET_KEY: "short" } }
  ];
  for (const entry of errorEnvs) {
    keyringErrors.push({
      label: entry.label,
      env: entry.env,
      expect: await outcome(() =>
        fingerprints(
          resolveKeyring(
            "JARVIS_AI_SECRET_KEY",
            "JARVIS_AI_SECRET_KEY_ID",
            "JARVIS_AI_SECRET_KEYS",
            "fixture-only-dev-default",
            entry.env
          )
        )
      )
    });
  }

  return {
    provenance: provenance(),
    keyrings: {
      ai: {
        names: ["JARVIS_AI_SECRET_KEY", "JARVIS_AI_SECRET_KEY_ID", "JARVIS_AI_SECRET_KEYS"],
        env: aiAfterRotation,
        legacyCandidateFingerprints: fingerprints(
          resolveKeyring(
            "JARVIS_AI_SECRET_KEY",
            "JARVIS_AI_SECRET_KEY_ID",
            "JARVIS_AI_SECRET_KEYS",
            "fixture-only-dev-default",
            aiAfterRotation
          )
        )
      },
      connector: {
        names: [
          "JARVIS_CONNECTOR_SECRET_KEY",
          "JARVIS_CONNECTOR_SECRET_KEY_ID",
          "JARVIS_CONNECTOR_SECRET_KEYS"
        ],
        env: connectorEnv
      }
    },
    cases,
    keyringErrors,
    family: await familyFixtures(),
    nodeDecoding: nodeDecodingSamples()
  };
}

/** What Node's lenient base64 and hex decoders return for odd input. */
function nodeDecodingSamples(): unknown {
  const base64 = [
    "QUJD",
    "QUJ",
    "QU",
    "Q",
    "QUJD===",
    "QQ==QUJD",
    "Q U\nJ\tD",
    "QU$JD!!",
    "-_-_",
    "+/+/"
  ];
  base64.push("\u00c1QUJD", "\u0134QUJD", "QUJ\u013dQUJD", "");
  const hexInputs = ["abcd", "ABCD", "abc", "abzz", "zzab", "ab cd", "\u01ab", "\u0161\u0162"];
  return {
    base64: base64.map((input) => ({
      input: text(input),
      hex: Buffer.from(input, "base64").toString("hex")
    })),
    hex: hexInputs.map((input) => ({
      input: text(input),
      hex: Buffer.from(input, "hex").toString("hex")
    }))
  };
}

/**
 * Nested family keys: the integrations key starts in the environment, moves into the
 * encrypted instance setting, then rotates. Uses the app's own generate/rotate/load code
 * against an in-memory stand-in for the one settings table it reads and writes.
 */
async function familyFixtures(): Promise<unknown> {
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
  const repository = {
    upsertInstanceSetting: async (
      _db: unknown,
      input: { key: string; value: Record<string, unknown> }
    ) => {
      settings.set(input.key, input.value);
    }
  };
  const write = { family: INTEGRATIONS_FAMILY, actorUserId: "fixture-user", requestId: "fixture" };
  const withEnvKey = { ...aiAfterRotation, JARVIS_INTEGRATIONS_SECRET_KEY: INTEGRATIONS_ENV_KEY };

  invalidateFamilyKeyCache(INTEGRATIONS_FAMILY);
  const envEra = await loadFamilyKeyring(fakeDb, INTEGRATIONS_FAMILY, withEnvKey);
  const envEraEnvelope = createIntegrationsCipherFromKeyring(envEra!).encryptJson({
    token: "fixture-only-env-era"
  });

  await generateFamilyKey(fakeDb, repository, { ...write, env: withEnvKey });
  invalidateFamilyKeyCache(INTEGRATIONS_FAMILY);
  const storeEra = await loadFamilyKeyring(fakeDb, INTEGRATIONS_FAMILY, aiAfterRotation);
  const storeEraEnvelope = createIntegrationsCipherFromKeyring(storeEra!).encryptJson({
    token: "fixture-only-store-era"
  });

  await rotateFamilyKey(fakeDb, repository, { ...write, env: aiAfterRotation });
  invalidateFamilyKeyCache(INTEGRATIONS_FAMILY);
  const rotated = await loadFamilyKeyring(fakeDb, INTEGRATIONS_FAMILY, aiAfterRotation);
  const rotatedCipher = createIntegrationsCipherFromKeyring(rotated!);
  const rotatedEnvelope = rotatedCipher.encryptJson({ token: "fixture-only-rotated" });

  const cases = [];
  for (const [label, envelope] of [
    ["env-era-key-v1", envEraEnvelope],
    ["store-era-key-s1", storeEraEnvelope],
    ["current-key-s2", rotatedEnvelope],
    ["legacy-no-id-env-era", withoutKeyId(envEraEnvelope)]
  ] as const) {
    cases.push({
      label,
      envelope,
      expect: await outcome(() =>
        jsonUtf8Base64(rotatedCipher.decryptJson(rotatedCipher.parseEnvelope(envelope)))
      )
    });
  }

  return {
    family: INTEGRATIONS_FAMILY.name,
    settingKey: INTEGRATIONS_FAMILY.settingKey,
    masterCipherLabel: "master key store",
    familyCipherLabel: "integration credential",
    storedSetting: settings.get(INTEGRATIONS_FAMILY.settingKey),
    currentKeyId: rotated!.currentKeyId,
    legacyCandidateFingerprints: fingerprints(rotated!),
    cases
  };
}

// ---------------------------------------------------------------------------------------------
// Fact 3: migration hashes
// ---------------------------------------------------------------------------------------------

async function migrationManifest(): Promise<string> {
  const core = join(repoRoot, "infra/postgres/migrations");
  const builtIn = getBuiltInSqlMigrationDirectories();
  const lines: string[] = [];
  const all = [];
  for (const directory of [core, ...builtIn]) {
    const files = await loadMigrationFiles(directory);
    all.push(...files);
    for (const file of files) {
      const path = join(directory, file.name);
      // The runner before 16f55070d hashed the file read as UTF-8 text, then re-encoded.
      const oldRule = createHash("sha256")
        .update(Buffer.from(await readFile(path, "utf8"), "utf8"))
        .digest("hex");
      lines.push(
        JSON.stringify({
          runner: "core",
          dir: relative(repoRoot, directory),
          name: file.name,
          version: file.version,
          checksum: file.checksum,
          backfill: file.backfill?.name ?? null,
          oldRuleChecksum: file.backfill ? null : oldRule
        })
      );
    }
  }
  assertUniqueMigrationVersions(all);

  const externalRoot = join(repoRoot, "external-modules");
  for (const moduleName of (await readdir(externalRoot)).sort()) {
    const directory = join(externalRoot, moduleName, "sql");
    for (const file of await loadModuleMigrationFiles(directory)) {
      lines.push(
        JSON.stringify({
          runner: "module",
          dir: relative(repoRoot, directory),
          name: file.name,
          version: file.version,
          checksum: file.checksum
        })
      );
    }
  }

  for (const [name, shim] of Object.entries(LEGACY_UPGRADE_SHIMS)) {
    lines.push(JSON.stringify({ runner: "pinned-shim", name, checksum: shim!.checksum }));
  }

  const header = JSON.stringify({ runner: "header", ...provenance(), entries: lines.length });
  return `${[header, ...lines].join("\n")}\n`;
}

interface EdgeFile {
  readonly name: string;
  readonly bytes: Buffer;
}

const utf8 = (text: string) => Buffer.from(text, "utf8");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SQL = "CREATE TABLE edge_case (id integer);\n";
const sidecar = (name: string) => `${name.replace(/\.sql$/, "")}.backfill.mjs`;
const decl = (name: string) => `-- moss:backfill ${sidecar(name)}`;
const BACKFILL_SOURCE =
  "export async function backfill(db) {\r\n  await db.query('select 1');\r\n}\r\n";

function coreCases(): { label: string; files: EdgeFile[] }[] {
  const name = "0001_edge.sql";
  const withSidecar = (sql: Buffer, extra: EdgeFile[] = []) => [
    { name, bytes: sql },
    { name: sidecar(name), bytes: Buffer.concat([BOM, utf8(BACKFILL_SOURCE)]) },
    ...extra
  ];
  return [
    { label: "plain-lf", files: [{ name, bytes: utf8(SQL) }] },
    { label: "crlf", files: [{ name, bytes: utf8(SQL.replace(/\n/g, "\r\n")) }] },
    { label: "bom-lf", files: [{ name, bytes: Buffer.concat([BOM, utf8(SQL)]) }] },
    { label: "bom-crlf", files: [{ name, bytes: Buffer.concat([BOM, utf8("-- c\r\n" + SQL)]) }] },
    { label: "empty-file", files: [{ name, bytes: Buffer.alloc(0) }] },
    { label: "backfill-lf", files: withSidecar(utf8(`${decl(name)}\n${SQL}`)) },
    { label: "backfill-crlf", files: withSidecar(utf8(`${decl(name)}\r\n${SQL}`)) },
    {
      label: "backfill-after-comments-and-blanks",
      files: withSidecar(utf8(`-- header\n\n   -- indented comment\n\t${decl(name)}  \n${SQL}`))
    },
    {
      label: "backfill-bom-first-line",
      files: withSidecar(Buffer.concat([BOM, utf8(`${decl(name)}\n${SQL}`)]))
    },
    {
      label: "backfill-feff-indent",
      files: withSidecar(utf8(`\ufeff\ufeff${decl(name)}\n${SQL}`))
    },
    { label: "backfill-nel-trailing", files: withSidecar(utf8(`${decl(name)}\u0085\n${SQL}`)) },
    {
      label: "backfill-nbsp-indent",
      files: withSidecar(utf8(`\u00a0${decl(name)}\u3000\n${SQL}`))
    },
    {
      label: "backfill-lone-cr-is-not-a-break",
      files: withSidecar(utf8(`-- a\r${decl(name)}\n${SQL}`))
    },
    { label: "declaration-after-sql", files: withSidecar(utf8(`${SQL}${decl(name)}\n`)) },
    {
      label: "declaration-twice",
      files: withSidecar(utf8(`${decl(name)}\n${decl(name)}\n${SQL}`))
    },
    {
      label: "declaration-wrong-name",
      files: withSidecar(utf8(`-- moss:backfill other.backfill.mjs\n${SQL}`))
    },
    {
      label: "declaration-no-space",
      files: withSidecar(utf8(`--moss:backfill ${sidecar(name)}\n${SQL}`))
    },
    {
      label: "declaration-nbsp-after-dashes",
      files: withSidecar(utf8(`--\u00a0moss:backfill ${sidecar(name)}\n${SQL}`))
    },
    {
      label: "declaration-feff-after-dashes",
      files: withSidecar(utf8(`--\ufeffmoss:backfill ${sidecar(name)}\n${SQL}`))
    },
    {
      label: "declaration-prefix-only",
      files: withSidecar(utf8(`-- moss:backfillable note\n${SQL}`))
    },
    {
      label: "declaration-bad-file-name",
      files: [
        {
          name: "0001_bad.name.sql",
          bytes: utf8(`-- moss:backfill 0001_bad.name.backfill.mjs\n${SQL}`)
        },
        { name: "0001_bad.name.backfill.mjs", bytes: utf8(BACKFILL_SOURCE) }
      ]
    },
    { label: "missing-sidecar", files: [{ name, bytes: utf8(`${decl(name)}\n${SQL}`) }] },
    {
      label: "invalid-utf8-sql",
      files: [{ name, bytes: Buffer.concat([utf8("-- "), Buffer.from([0xc3, 0x28]), utf8(SQL)]) }]
    },
    {
      label: "invalid-utf8-sidecar",
      files: [
        { name, bytes: utf8(`${decl(name)}\n${SQL}`) },
        { name: sidecar(name), bytes: Buffer.from([0x2f, 0x2f, 0xff, 0x0a]) }
      ]
    },
    {
      label: "version-and-order",
      files: [
        { name: "0010_c.sql", bytes: utf8(SQL) },
        { name: "0002_b.sql", bytes: utf8(SQL) },
        { name: "0002_B.sql", bytes: utf8(SQL) },
        { name: "noversion.sql", bytes: utf8(SQL) },
        { name: "0004_\u{1f600}.sql", bytes: utf8(SQL) },
        { name: "0004_ｚ.sql", bytes: utf8(SQL) },
        { name: "notes.txt", bytes: utf8("not a migration") }
      ]
    },
    { label: "empty-version", files: [{ name: "_leading.sql", bytes: utf8(SQL) }] }
  ];
}

function moduleCases(): { label: string; files: EdgeFile[] }[] {
  const name = "0001_module_edge.sql";
  const invalid = (bytes: number[]) => [
    { name, bytes: Buffer.concat([utf8("-- note "), Buffer.from(bytes), utf8("\n" + SQL)]) }
  ];
  return [
    { label: "module-plain", files: [{ name, bytes: utf8(SQL) }] },
    {
      label: "module-bom-crlf",
      files: [{ name, bytes: Buffer.concat([BOM, utf8(SQL.replace(/\n/g, "\r\n"))]) }]
    },
    { label: "module-lone-continuation", files: invalid([0x80]) },
    { label: "module-overlong", files: invalid([0xc0, 0xaf]) },
    { label: "module-truncated-3-byte", files: invalid([0xe2, 0x82]) },
    { label: "module-encoded-surrogate", files: invalid([0xed, 0xa0, 0x80]) },
    { label: "module-above-max", files: invalid([0xf4, 0x90, 0x80, 0x80]) },
    { label: "module-ff-fe", files: invalid([0xff, 0xfe]) },
    {
      label: "module-mixed",
      files: invalid([0xe2, 0x28, 0xa1, 0xf0, 0x9f, 0x98, 0xe2, 0x82, 0xac])
    },
    {
      label: "module-truncated-at-end",
      files: [{ name, bytes: Buffer.concat([utf8(SQL + "-- "), Buffer.from([0xf0, 0x9f, 0x98])]) }]
    },
    { label: "module-version-no-underscore", files: [{ name: "0001.sql", bytes: utf8(SQL) }] },
    {
      label: "module-refused-statement",
      files: [{ name, bytes: utf8("DROP TABLE finance_items;\n") }]
    }
  ];
}

type LoadedFile = { name: string; version: string; checksum: string; backfill?: { name: string } };

async function runEdgeCases(): Promise<unknown> {
  const results: unknown[] = [];
  const run = async (runner: "core" | "module", label: string, files: EdgeFile[]) => {
    const directory = await mkdtemp(join(tmpdir(), "js34-edge-"));
    try {
      for (const file of files) await writeFile(join(directory, file.name), file.bytes);
      const loaded = await outcome(async () => {
        const list: readonly LoadedFile[] =
          runner === "core"
            ? await loadMigrationFiles(directory)
            : await loadModuleMigrationFiles(directory);
        return list.map((file) => ({
          name: file.name,
          version: file.version,
          checksum: file.checksum,
          backfill: file.backfill?.name ?? null
        }));
      });
      const expect =
        "error" in loaded ? { error: loaded.error.split(directory).join("<dir>") } : loaded;
      results.push({
        label,
        runner,
        files: files.map((file) => ({
          name: text(file.name),
          base64: file.bytes.toString("base64")
        })),
        expect
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  for (const entry of coreCases()) await run("core", entry.label, entry.files);
  for (const entry of moduleCases()) await run("module", entry.label, entry.files);
  return { provenance: provenance(), cases: results };
}

// ---------------------------------------------------------------------------------------------

await mkdir(fixturesDir, { recursive: true });
const writeJson = (name: string, value: unknown) =>
  writeFile(join(fixturesDir, name), `${JSON.stringify(value, null, 2)}\n`);

await writeJson("passwords.json", await passwordFixtures());
await writeJson("secrets.json", await secretFixtures());
await writeFile(join(fixturesDir, "migrations-manifest.jsonl"), await migrationManifest());
await writeJson("migrations-edge.json", await runEdgeCases());
console.log(`fixtures written to ${relative(repoRoot, fixturesDir)}`);
