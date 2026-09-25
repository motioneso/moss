/**
 * Proof that a Codex access token was issued by OpenAI (#2687).
 *
 * A user can edit the login file in their own home, so its claims mean nothing until the token's
 * signature checks out against OpenAI's published signing keys. Only a verified token may replace
 * the shared login.
 */
import { createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from "node:crypto";

type JsonWebKey = JsonWebKeyInput["key"] & { readonly kid?: unknown };

/** Resolves true only for a token OpenAI signed, issued no later than now. */
export type CodexTokenVerifier = (accessToken: string) => Promise<boolean>;

export interface SigningKeySource {
  /** OpenAI's current signing keys, as a JWKS document's `keys`. */
  fetchKeys(): Promise<readonly JsonWebKey[]>;
  now(): number;
}

const ISSUER = "https://auth.openai.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const KEY_TTL_MS = 60 * 60 * 1000;
const REFETCH_FLOOR_MS = 5 * 60 * 1000;
const CLOCK_SKEW_S = 5 * 60;
const FETCH_TIMEOUT_MS = 5_000;

function decodePart(part: string | undefined): Record<string, unknown> | null {
  if (!part) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function fetchOpenAiKeys(): Promise<readonly JsonWebKey[]> {
  const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`signing keys unavailable (${response.status})`);
  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("signing keys unavailable");
  return body.keys as JsonWebKey[];
}

/** Build a verifier that caches the signing keys and refetches them for an unknown key id. */
export function createCodexTokenVerifier(
  source: SigningKeySource = { fetchKeys: fetchOpenAiKeys, now: () => Date.now() }
): CodexTokenVerifier {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = Number.NEGATIVE_INFINITY;

  const refresh = async (): Promise<void> => {
    const next = new Map<string, KeyObject>();
    for (const jwk of await source.fetchKeys()) {
      if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        continue;
      }
    }
    keys = next;
    fetchedAt = source.now();
  };

  const keyFor = async (kid: string): Promise<KeyObject | undefined> => {
    const age = source.now() - fetchedAt;
    if (age > KEY_TTL_MS || (!keys.has(kid) && age > REFETCH_FLOOR_MS)) {
      // A failed fetch waits out the refetch floor, so an outage never stalls every launch.
      await refresh().catch(() => {
        fetchedAt = source.now();
      });
    }
    return keys.get(kid);
  };

  return async (accessToken) => {
    const [head, body, signature] = accessToken.split(".");
    const header = decodePart(head);
    const claims = decodePart(body);
    if (!header || !claims || !signature) return false;
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
    if (claims.iss !== ISSUER) return false;
    const iat = claims.iat;
    if (typeof iat !== "number" || iat > source.now() / 1000 + CLOCK_SKEW_S) return false;
    const key = await keyFor(header.kid);
    if (!key) return false;
    return verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      key,
      Buffer.from(signature, "base64url")
    );
  };
}

let defaultVerifier: CodexTokenVerifier | undefined;

/** The process-wide verifier, sharing one cache of OpenAI's signing keys. */
export function openAiCodexTokenVerifier(): CodexTokenVerifier {
  defaultVerifier ??= createCodexTokenVerifier();
  return defaultVerifier;
}
