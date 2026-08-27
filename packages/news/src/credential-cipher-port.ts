import type { EncryptedSecret } from "@moss/db";

/**
 * The encryption seam for News publisher credentials (#2005).
 *
 * News declares what it needs and never resolves key material: the concrete cipher
 * is built in the composition root (packages/module-registry/src/news-credential-cipher.ts)
 * and injected. News must not import from @moss/settings and must not call
 * resolveKeyring — that is what keeps key resolution out of a feature module.
 */
export interface NewsCredentialCipherPort {
  encrypt(secret: { readonly apiKey: string }): EncryptedSecret;
  /**
   * NOTE: this slice has ZERO production decrypt call sites. #2007 (the outbound
   * publisher request) is the consumer; here it exists so the seam is complete and
   * is exercised only by tests.
   */
  decrypt(envelope: EncryptedSecret): { readonly apiKey: string };
}
