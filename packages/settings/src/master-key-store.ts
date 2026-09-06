import { randomBytes } from "node:crypto";

import {
  JsonSecretCipher,
  resolveKeyring,
  resolveMossEnv,
  type DataContextDb,
  type EncryptedSecret,
  type Keyring
} from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import {
  INTEGRATIONS_FAMILY_KEY_SETTING,
  MODULE_CREDENTIAL_FAMILY_KEY_SETTING,
  NEWS_CREDENTIAL_FAMILY_KEY_SETTING
} from "./instance-settings-keys.js";

/**
 * Master key store (#2312 slice 1): per-family key-encryption keys kept as
 * AES-256-GCM envelopes in instance settings, locked with the master (AI) keyring.
 * Env values win when set so existing installs keep working untouched; a missing
 * family resolves to null (degraded feature), never a throw — nothing here may
 * break startup. Slice 1 covers integrations only; slice 2 appends families.
 *
 * Security note on placement: migration 0059's comment justifies the open read
 * policy on this table with "non-secret config only". That premise no longer holds
 * — this table now holds sealed key envelopes — so the comment there is stale (left
 * untouched: applied migrations are checksum-tracked). The posture stays safe
 * because the values are ciphertext under the master keyring and no endpoint
 * returns the row; only presence ("env", "store", "missing", "broken") leaves.
 *
 * Rotation note: retired keys accumulate in the row and nothing re-encrypts old
 * data, so the row grows with history and rotation alone reduces no exposure. That
 * is a deliberate slice-1 tradeoff for never losing readable credentials; a future
 * re-encryption pass can trim it.
 */

export interface FamilyKeyDescriptor {
  readonly name: string;
  readonly settingKey: string;
  readonly keyEnvVar: string;
  readonly keyIdEnvVar: string;
  readonly keysEnvVar: string;
  readonly devDefault: string;
}

export const INTEGRATIONS_FAMILY: FamilyKeyDescriptor = {
  name: "integrations",
  settingKey: INTEGRATIONS_FAMILY_KEY_SETTING,
  keyEnvVar: "JARVIS_INTEGRATIONS_SECRET_KEY",
  keyIdEnvVar: "JARVIS_INTEGRATIONS_SECRET_KEY_ID",
  keysEnvVar: "JARVIS_INTEGRATIONS_SECRET_KEYS",
  devDefault: "jarv1s-development-integrations-secret"
};

export const MODULE_CREDENTIAL_FAMILY: FamilyKeyDescriptor = {
  name: "module_credential",
  settingKey: MODULE_CREDENTIAL_FAMILY_KEY_SETTING,
  keyEnvVar: "JARVIS_MODULE_CREDENTIAL_SECRET_KEY",
  keyIdEnvVar: "JARVIS_MODULE_CREDENTIAL_SECRET_KEY_ID",
  keysEnvVar: "JARVIS_MODULE_CREDENTIAL_SECRET_KEYS",
  devDefault: "jarv1s-development-module-credential-secret"
};

export const NEWS_CREDENTIAL_FAMILY: FamilyKeyDescriptor = {
  name: "news_credential",
  settingKey: NEWS_CREDENTIAL_FAMILY_KEY_SETTING,
  keyEnvVar: "JARVIS_NEWS_CREDENTIAL_SECRET_KEY",
  keyIdEnvVar: "JARVIS_NEWS_CREDENTIAL_SECRET_KEY_ID",
  keysEnvVar: "JARVIS_NEWS_CREDENTIAL_SECRET_KEYS",
  devDefault: "jarv1s-development-news-credential-secret"
};

const FAMILIES: readonly FamilyKeyDescriptor[] = [
  INTEGRATIONS_FAMILY,
  MODULE_CREDENTIAL_FAMILY,
  NEWS_CREDENTIAL_FAMILY
];

/** Look up a family by the name the admin routes receive. */
export function familyByName(name: string): FamilyKeyDescriptor | null {
  return FAMILIES.find((family) => family.name === name) ?? null;
}

/** {@link JsonSecretCipher} bound to the "master key store" domain label. */
export class MasterKeyStoreCipher extends JsonSecretCipher {
  constructor(keyring: Keyring) {
    super(keyring, "master key store");
  }
}

/**
 * Build the master cipher. Reuses the AI secret keyring (already a required deploy
 * secret) — the domain label differs so envelopes stay self-describing.
 */
export function createMasterKeyStoreCipher(
  env: NodeJS.ProcessEnv = process.env
): MasterKeyStoreCipher {
  return new MasterKeyStoreCipher(
    resolveKeyring(
      "JARVIS_AI_SECRET_KEY",
      "JARVIS_AI_SECRET_KEY_ID",
      "JARVIS_AI_SECRET_KEYS",
      "jarv1s-development-ai-secret",
      env
    )
  );
}

interface StoredFamilyKey {
  readonly keyId: string;
  readonly secret: string;
  readonly retired: readonly { readonly keyId: string; readonly secret: string }[];
}

const SECRET_FIELD = "secret";

/**
 * How long a loaded family keyring stays in memory. The cache is per process
 * and the save/rotate refresh hook only runs in the interface process, so a
 * background worker would otherwise keep a pre-rotation key indefinitely and
 * fail to read anything written after the rotation. A short life bounds that
 * staleness everywhere; the reload-and-retry helper below covers the gap.
 */
export const FAMILY_KEY_CACHE_TTL_MS = 60_000;

interface CachedFamilyKeyring {
  readonly keyring: Keyring;
  readonly loadedAtMs: number;
}

const familyKeyringCache = new Map<string, CachedFamilyKeyring>();

function readCachedFamilyKeyring(family: FamilyKeyDescriptor): Keyring | null {
  const cached = familyKeyringCache.get(family.settingKey);
  if (!cached) return null;
  if (Date.now() - cached.loadedAtMs >= FAMILY_KEY_CACHE_TTL_MS) {
    familyKeyringCache.delete(family.settingKey);
    return null;
  }
  return cached.keyring;
}

function storeCachedFamilyKeyring(family: FamilyKeyDescriptor, keyring: Keyring): void {
  familyKeyringCache.set(family.settingKey, { keyring, loadedAtMs: Date.now() });
}

/** Drop cached family keyrings (all, or one family) after save/rotate. */
export function invalidateFamilyKeyCache(family?: FamilyKeyDescriptor): void {
  if (family) familyKeyringCache.delete(family.settingKey);
  else familyKeyringCache.clear();
}

async function readFamilySettingValue(
  scopedDb: DataContextDb,
  settingKey: string
): Promise<unknown> {
  const row = await scopedDb.db
    .selectFrom("app.instance_settings")
    .select(["value"])
    .where("key", "=", settingKey)
    .executeTakeFirst();
  if (!row) return null;
  return (row.value as { value?: unknown } | null)?.value ?? null;
}

type FamilyRowState = "missing" | "broken" | "ok";

/**
 * A row that exists but cannot be decrypted (master secret changed without
 * keeping the old one) is BROKEN, not missing: the screen must say the feature
 * is stopped and offer replacement, never report healthy or silently overwrite.
 */
function familyRowState(stored: unknown, cipher: MasterKeyStoreCipher): FamilyRowState {
  if (stored == null) return "missing";
  try {
    cipher.decryptJson(cipher.parseEnvelope(stored));
    return "ok";
  } catch {
    return "broken";
  }
}

function readStoredFamilyKey(
  stored: unknown,
  cipher: MasterKeyStoreCipher
): StoredFamilyKey | null {
  if (stored == null) return null;
  let decrypted: Record<string, unknown>;
  try {
    decrypted = cipher.decryptJson(cipher.parseEnvelope(stored));
  } catch {
    // Corrupt row reads as missing (degraded + banner); the admin regenerates.
    return null;
  }
  const keyId = decrypted.keyId;
  const secret = decrypted[SECRET_FIELD];
  if (typeof keyId !== "string" || typeof secret !== "string") return null;
  const retired = decrypted.retired;
  if (retired !== undefined && !Array.isArray(retired)) return null;
  return {
    keyId,
    secret,
    retired: Array.isArray(retired)
      ? retired.filter(
          (entry): entry is { keyId: string; secret: string } =>
            typeof entry?.keyId === "string" && typeof entry?.secret === "string"
        )
      : []
  };
}

/**
 * Load a family's keyring: env value wins (existing rotation semantics kept),
 * else the store row decrypted with the master, else null when neither exists.
 * Null is a normal outcome meaning "needs attention", not an error.
 */
export async function loadFamilyKeyring(
  scopedDb: DataContextDb,
  family: FamilyKeyDescriptor,
  env: NodeJS.ProcessEnv = process.env
): Promise<Keyring | null> {
  const cached = readCachedFamilyKeyring(family);
  if (cached) return cached;

  if (resolveMossEnv(env, family.keyEnvVar) !== undefined) {
    const keyring = resolveKeyring(
      family.keyEnvVar,
      family.keyIdEnvVar,
      family.keysEnvVar,
      family.devDefault,
      env
    );
    storeCachedFamilyKeyring(family, keyring);
    return keyring;
  }

  const cipher = createMasterKeyStoreCipher(env);
  const stored = readStoredFamilyKey(
    await readFamilySettingValue(scopedDb, family.settingKey),
    cipher
  );
  if (!stored) {
    // No env value, no store row. Outside hardened environments the loader keeps
    // the old constructor behavior and falls back to the development default, so
    // a fresh dev install keeps working with zero setup (#2322 slice 2). In a
    // hardened environment resolveKeyring throws for the missing key and that
    // maps to null below: paused with setup guidance, never a boot throw.
    try {
      const fallback = resolveKeyring(
        family.keyEnvVar,
        family.keyIdEnvVar,
        family.keysEnvVar,
        family.devDefault,
        env
      );
      storeCachedFamilyKeyring(family, fallback);
      return fallback;
    } catch {
      return null;
    }
  }
  const current = Buffer.from(stored.secret, "hex");
  const keys = new Map<string, Buffer>([[stored.keyId, current]]);
  const legacyCandidates: Buffer[] = [current];
  for (const retired of stored.retired) {
    if (keys.has(retired.keyId)) continue;
    const previous = Buffer.from(retired.secret, "hex");
    keys.set(retired.keyId, previous);
    legacyCandidates.push(previous);
  }
  const keyring: Keyring = { currentKeyId: stored.keyId, keys, legacyCandidates };
  storeCachedFamilyKeyring(family, keyring);
  return keyring;
}

/**
 * Run one decrypt against the family's keyring, reloading once and retrying
 * when the first attempt fails. Covers the cross-process gap: a worker holding
 * a pre-rotation keyring fails the first decrypt, drops its stale entry, reads
 * the fresh row, and succeeds — instead of surfacing the rotation as an error.
 * A second failure means the data is genuinely unreadable, so it rethrows.
 */
/**
 * Thrown when a family key exists nowhere: no env value, no store row. Callers
 * map this to their layer's paused/setup-guidance signal (never a crash).
 */
export class FamilyKeyMissingError extends Error {
  constructor(readonly familyName: string) {
    super(`No ${familyName} key available`);
    this.name = "FamilyKeyMissingError";
  }
}

export async function decryptWithFamilyKeyRefresh<T>(
  scopedDb: DataContextDb,
  family: FamilyKeyDescriptor,
  env: NodeJS.ProcessEnv,
  attempt: (keyring: Keyring) => T
): Promise<T> {
  const first = await loadFamilyKeyring(scopedDb, family, env);
  if (!first) throw new FamilyKeyMissingError(family.name);
  try {
    return attempt(first);
  } catch {
    invalidateFamilyKeyCache(family);
    const fresh = await loadFamilyKeyring(scopedDb, family, env);
    if (!fresh) throw new FamilyKeyMissingError(family.name);
    return attempt(fresh);
  }
}

export interface FamilyKeyWrite {
  readonly family: FamilyKeyDescriptor;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface FamilyKeyStore {
  upsertInstanceSetting(
    scopedDb: DataContextDb,
    input: {
      key: string;
      value: Record<string, unknown>;
      updatedByUserId: string;
      requestId: string;
      action: string;
      metadata: Record<string, unknown>;
    }
  ): Promise<unknown>;
}

function nextKeyId(current: string | null, taken: ReadonlySet<string>): string {
  const match = current ? /^s(\d+)$/.exec(current) : null;
  let next = match ? Number(match[1]) + 1 : 1;
  while (taken.has(`s${next}`)) next += 1;
  return `s${next}`;
}

/**
 * Create (or replace) a family key: 32 fresh random bytes stored encrypted under
 * the master. Whatever protected data before stays readable: the previous secret
 * rides along as a retired candidate, including an env-derived one when moving a
 * family from env into the store.
 */
export async function generateFamilyKey(
  scopedDb: DataContextDb,
  repository: FamilyKeyStore,
  input: FamilyKeyWrite
): Promise<void> {
  const env = input.env ?? process.env;
  const cipher = createMasterKeyStoreCipher(env);
  const stored = await readFamilySettingValue(scopedDb, input.family.settingKey);
  const existing = readStoredFamilyKey(stored, cipher);
  // Replacing a row that exists but no longer decrypts is a recovery, not a
  // first setup: record it in the audit trail because anything sealed under the
  // old key stays unreadable afterwards.
  const recovered = stored != null && existing == null;
  // Moving a family out of the settings file must carry EVERY key that file holds —
  // current plus the whole retired list — or credentials sealed under a retired key
  // become permanently unreadable once the file values are removed. resolveKeyring
  // already folds the retired-keys value into one keyring, so take all its entries.
  const retired: { keyId: string; secret: string }[] = [...(existing?.retired ?? [])];
  if (existing) {
    retired.push({ keyId: existing.keyId, secret: existing.secret });
  } else if (resolveMossEnv(env, input.family.keyEnvVar) !== undefined) {
    const envKeyring = resolveKeyring(
      input.family.keyEnvVar,
      input.family.keyIdEnvVar,
      input.family.keysEnvVar,
      input.family.devDefault,
      env
    );
    for (const [keyId, secret] of envKeyring.keys) {
      if (!retired.some((entry) => entry.keyId === keyId)) {
        retired.push({ keyId, secret: secret.toString("hex") });
      }
    }
  }
  const taken = new Set([existing?.keyId, ...retired.map((entry) => entry.keyId)]);
  taken.delete(undefined);
  const payload: StoredFamilyKey = {
    keyId: nextKeyId(existing?.keyId ?? null, taken as ReadonlySet<string>),
    secret: randomBytes(32).toString("hex"),
    retired
  };
  const envelope: EncryptedSecret = cipher.encryptJson({
    keyId: payload.keyId,
    [SECRET_FIELD]: payload.secret,
    retired: payload.retired
  });
  await repository.upsertInstanceSetting(scopedDb, {
    key: input.family.settingKey,
    value: { value: envelope },
    updatedByUserId: input.actorUserId,
    requestId: input.requestId,
    action: "instance_setting.family_key.set",
    metadata: recovered
      ? { key: input.family.settingKey, recoveredFromUnreadable: true }
      : { key: input.family.settingKey }
  });
}

/**
 * Rotate a family key. A row that exists but no longer decrypts is recoverable by
 * replacement (the audit trail records it); only a family with no row and no env
 * key 404s. Cache invalidation stays with the caller so it lands after commit.
 */
export async function rotateFamilyKey(
  scopedDb: DataContextDb,
  repository: FamilyKeyStore,
  input: FamilyKeyWrite
): Promise<void> {
  const env = input.env ?? process.env;
  const stored = await readFamilySettingValue(scopedDb, input.family.settingKey);
  if (stored == null && resolveMossEnv(env, input.family.keyEnvVar) === undefined) {
    throw new HttpError(404, `No ${input.family.name} key to rotate`);
  }
  await generateFamilyKey(scopedDb, repository, input);
}

export interface FamilyKeyStatus {
  readonly family: string;
  readonly source: "env" | "store" | "missing" | "broken";
}

/**
 * Presence-only status for every known family; never carries key material. A row
 * that exists but no longer decrypts reports "broken" so the screen tells the
 * truth instead of showing healthy.
 */
export async function getFamilyKeyStatus(
  scopedDb: DataContextDb,
  env: NodeJS.ProcessEnv = process.env
): Promise<FamilyKeyStatus[]> {
  const cipher = createMasterKeyStoreCipher(env);
  const statuses: FamilyKeyStatus[] = [];
  for (const family of FAMILIES) {
    if (resolveMossEnv(env, family.keyEnvVar) !== undefined) {
      statuses.push({ family: family.name, source: "env" });
    } else {
      const state = familyRowState(
        await readFamilySettingValue(scopedDb, family.settingKey),
        cipher
      );
      statuses.push({
        family: family.name,
        source: state === "ok" ? "store" : state
      });
    }
  }
  return statuses;
}
