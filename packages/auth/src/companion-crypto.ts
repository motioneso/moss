import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { COMPANION_CREDENTIAL_PREFIX } from "@moss/shared";

/**
 * Secret handling for the Trail Marker pairing exchange (#2560). Every value the
 * server persists is a digest: the pairing verifier, the browser approval code and
 * the companion credential. A database read therefore yields nothing an attacker
 * can present back to the server.
 */

/** base64url sha256 digest, 43 characters, no padding. */
export function sha256Base64url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

export function randomBase64url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export interface MintedCredential {
  /** Returned to the Mac exactly once, in the redeem response. */
  readonly credential: string;
  /** All the server keeps. */
  readonly hash: string;
}

export function mintCompanionCredential(): MintedCredential {
  const credential = `${COMPANION_CREDENTIAL_PREFIX}${randomBase64url(32)}`;
  return { credential, hash: sha256Base64url(credential) };
}

/**
 * Constant-time digest comparison. Both sides are fixed-length base64url sha256
 * output, so a length difference only ever means a malformed caller value.
 */
export function digestsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
