import { createHash, randomBytes } from "node:crypto";

import {
  JsonSecretCipher,
  resolveKeyring,
  resolveMossEnv,
  type DataContextDb,
  type EncryptedSecret,
  type Keyring
} from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import { INTEGRATIONS_FAMILY_KEY_SETTING } from "./instance-settings-keys.js";

/**
 * Master key store (#2312 slice 1): per-family key-encryption keys kept as
 * AES-256-GCM envelopes in instance settings, locked with the master (AI) keyring.
 * Env values win when set so existing installs keep working untouched; a missing
 * family resolves to null (degraded feature), never a throw — nothing here may
 * break startup. Slice 1 covers integrations only; slice 2 appends families.
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

const FAMILIES: readonly FamilyKeyDescriptor[] = [INTEGRATIONS_FAMILY];

/** Setting keys holding family envelopes (subset of the secret registry). */
export const SECRET_FAMILY_SETTINGS: ReadonlySet<string> = new Set(
  FAMILIES.map((family) => family.settingKey)
);

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
  readonly previous?: { readonly keyId: string; readonly secret: string };
}

const SECRET_FIELD = "secret";

const familyKeyringCache = new Map<string, Keyring>();

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
  const previous = decrypted.previous as StoredFamilyKey["previous"] | undefined;
  return { keyId, secret, previous };
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
  const cached = familyKeyringCache.get(family.settingKey);
  if (cached) return cached;

  if (resolveMossEnv(env, family.keyEnvVar) !== undefined) {
    const keyring = resolveKeyring(
      family.keyEnvVar,
      family.keyIdEnvVar,
      family.keysEnvVar,
      family.devDefault,
      env
    );
    familyKeyringCache.set(family.settingKey, keyring);
    return keyring;
  }

  const cipher = createMasterKeyStoreCipher(env);
  const stored = readStoredFamilyKey(await readFamilySettingValue(scopedDb, family.settingKey), cipher);
  if (!stored) return null;
  const current = Buffer.from(stored.secret, "hex");
  const keys = new Map<string, Buffer>([[stored.keyId, current]]);
  const legacyCandidates: Buffer[] = [current];
  if (stored.previous) {
    const previous = Buffer.from(stored.previous.secret, "hex");
    keys.set(stored.previous.keyId, previous);
    legacyCandidates.push(previous);
  }
  const keyring: Keyring = { currentKeyId: stored.keyId, keys, legacyCandidates };
  familyKeyringCache.set(family.settingKey, keyring);
  return keyring;
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
      value: unknown;
      updatedByUserId: string;
      requestId: string;
      action: string;
      metadata: Record<string, unknown>;
    }
  ): Promise<unknown>;
}

function nextKeyId(current: string | null): string {
  const match = current ? /^s(\d+)$/.exec(current) : null;
  return `s${match ? Number(match[1]) + 1 : 1}`;
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
  const existing = readStoredFamilyKey(
    await readFamilySettingValue(scopedDb, input.family.settingKey),
    cipher
  );
  const envSecret = resolveMossEnv(env, input.family.keyEnvVar);
  const previous = existing
    ? { keyId: existing.keyId, secret: existing.secret }
    : envSecret !== undefined
      ? {
          keyId: resolveMossEnv(env, input.family.keyIdEnvVar) ?? "v1",
          secret: createHash("sha256").update(envSecret).digest("hex")
        }
      : undefined;
  const payload: StoredFamilyKey = {
    keyId: nextKeyId(existing?.keyId ?? null),
    secret: randomBytes(32).toString("hex"),
    ...(previous ? { previous } : {})
  };
  const envelope: EncryptedSecret = cipher.encryptJson({
    keyId: payload.keyId,
    [SECRET_FIELD]: payload.secret,
    ...(payload.previous ? { previous: payload.previous } : {})
  });
  await repository.upsertInstanceSetting(scopedDb, {
    key: input.family.settingKey,
    value: { value: envelope },
    updatedByUserId: input.actorUserId,
    requestId: input.requestId,
    action: "instance_setting.family_key.set",
    metadata: { key: input.family.settingKey }
  });
  invalidateFamilyKeyCache(input.family);
}

/** Rotate an existing family key; throws 404 when there is nothing to rotate. */
export async function rotateFamilyKey(
  scopedDb: DataContextDb,
  repository: FamilyKeyStore,
  input: FamilyKeyWrite
): Promise<void> {
  const env = input.env ?? process.env;
  const cipher = createMasterKeyStoreCipher(env);
  const existing = readStoredFamilyKey(
    await readFamilySettingValue(scopedDb, input.family.settingKey),
    cipher
  );
  if (!existing && resolveMossEnv(env, input.family.keyEnvVar) === undefined) {
    throw new HttpError(404, `No ${input.family.name} key to rotate`);
  }
  await generateFamilyKey(scopedDb, repository, input);
}

export interface FamilyKeyStatus {
  readonly family: string;
  readonly source: "env" | "store" | "missing";
}

/** Presence-only status for every known family; never carries key material. */
export async function getFamilyKeyStatus(
  scopedDb: DataContextDb,
  env: NodeJS.ProcessEnv = process.env
): Promise<FamilyKeyStatus[]> {
  const statuses: FamilyKeyStatus[] = [];
  for (const family of FAMILIES) {
    if (resolveMossEnv(env, family.keyEnvVar) !== undefined) {
      statuses.push({ family: family.name, source: "env" });
    } else if ((await readFamilySettingValue(scopedDb, family.settingKey)) != null) {
      statuses.push({ family: family.name, source: "store" });
    } else {
      statuses.push({ family: family.name, source: "missing" });
    }
  }
  return statuses;
}
