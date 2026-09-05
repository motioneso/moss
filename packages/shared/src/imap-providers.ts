/**
 * Email-domain lookup for the password-based IMAP presets. The web "Add an email account"
 * flow asks for the address first, derives the domain, and uses this table to pick the
 * matching preset (server settings live server-side in @moss/connectors/presets; the
 * frontend only needs the provider id and its setup instructions).
 *
 * Keep the ids in step with `imapConnectRequestSchema.properties.providerId.enum` in
 * connectors-api.ts — the API rejects any id not in that enum.
 */
export type ImapProviderId = "imap-yahoo" | "imap-proton" | "imap-icloud" | "imap-fastmail";

export const IMAP_PROVIDER_EMAIL_DOMAINS: Readonly<Record<ImapProviderId, readonly string[]>> = {
  "imap-yahoo": [
    "yahoo.com",
    "yahoo.co.uk",
    "yahoo.ca",
    "yahoo.com.au",
    "ymail.com",
    "rocketmail.com"
  ],
  "imap-proton": ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
  "imap-icloud": ["icloud.com", "me.com", "mac.com"],
  "imap-fastmail": ["fastmail.com", "fastmail.fm", "fastmail.us"]
};

/** Lower-cased domain part of an email address, or null when there is no "@" with text after it. */
export function emailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return null;
  const domain = trimmed.slice(at + 1);
  return domain.length > 0 ? domain : null;
}

/** Provider preset whose known email domains include the address's domain, or null. */
export function findImapProviderIdForEmail(email: string): ImapProviderId | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  for (const [providerId, domains] of Object.entries(IMAP_PROVIDER_EMAIL_DOMAINS)) {
    if (domains.includes(domain)) return providerId as ImapProviderId;
  }
  return null;
}
