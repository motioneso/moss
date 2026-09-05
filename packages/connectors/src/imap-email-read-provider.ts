import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import type { ParsedEmail } from "./email-extract.js";
import type { EmailReadProvider, MailMessageKey } from "./email-read-provider.js";
import { decodeImapExternalId, encodeImapExternalId } from "./imap-message-key.js";
import type { ImapConnectionSecret } from "./imap-secret.js";

/** Mirrors Google's `newer_than:30d` sync query — bounds the fetch window (spec §7a). */
export const IMAP_READ_WINDOW_DAYS = 30;
export const IMAP_DEFAULT_FOLDER = "INBOX";

/** Minimal subset of ImapFlow this provider needs — narrowed for testability (fakes in tests). */
export interface ImapFlowLike {
  connect(): Promise<unknown>;
  logout(): Promise<void>;
  close(): void | Promise<void>;
  list(): Promise<Array<{ path: string }>>;
  mailboxOpen(
    path: string,
    opts?: { readOnly?: boolean }
  ): Promise<{ uidValidity: bigint | number | string }>;
  search(query: Record<string, unknown>, opts: { uid: boolean }): Promise<number[] | false>;
  fetchOne(
    range: string,
    query: Record<string, unknown>,
    opts: { uid: boolean }
  ): Promise<{ uid: number; source?: Buffer } | false>;
}

export type ImapClientFactory = (secret: ImapConnectionSecret) => ImapFlowLike;

function defaultClientFactory(secret: ImapConnectionSecret): ImapFlowLike {
  return new ImapFlow({
    host: secret.imapHost,
    port: secret.imapPort,
    secure: secret.imapTls,
    auth: { user: secret.username, pass: secret.password },
    logger: false
  }) as unknown as ImapFlowLike;
}

async function withImapClient<T>(
  factory: ImapClientFactory,
  secret: ImapConnectionSecret,
  fn: (client: ImapFlowLike) => Promise<T>
): Promise<T> {
  const client = factory(secret);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      await client.close();
    }
  }
}

/**
 * IMAP implementation of the provider-neutral EmailReadProvider seam (Slice A). Every method
 * takes the full decrypted ImapConnectionSecret as its credential — IMAP has no access token
 * to refresh, unlike Google (spec §9).
 */
export class ImapEmailReadProvider implements EmailReadProvider<ImapConnectionSecret> {
  constructor(private readonly clientFactory: ImapClientFactory = defaultClientFactory) {}

  async listFolders(secret: ImapConnectionSecret): Promise<string[]> {
    return withImapClient(this.clientFactory, secret, async (client) => {
      const entries = await client.list();
      return entries.map((entry) => entry.path);
    });
  }

  async listMessageKeys(secret: ImapConnectionSecret, folder: string): Promise<MailMessageKey[]> {
    return withImapClient(this.clientFactory, secret, async (client) => {
      const box = await client.mailboxOpen(folder, { readOnly: true });
      const since = new Date(Date.now() - IMAP_READ_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since }, { uid: true });
      if (!uids) return [];
      const uidValidity = String(box.uidValidity);
      return uids.map((uid) => ({
        folder,
        id: encodeImapExternalId({ folder, uidValidity, uid })
      }));
    });
  }

  async getMessage(secret: ImapConnectionSecret, key: MailMessageKey): Promise<ParsedEmail> {
    const identity = decodeImapExternalId(key.id);
    if (!identity) {
      throw new Error("Malformed IMAP message key");
    }
    return withImapClient(this.clientFactory, secret, async (client) => {
      await client.mailboxOpen(identity.folder, { readOnly: true });
      const message = await client.fetchOne(
        String(identity.uid),
        { uid: true, source: true },
        {
          uid: true
        }
      );
      if (!message || !message.source) {
        throw new Error("IMAP message not found or has no source");
      }
      const mail = await simpleParser(message.source);
      const recipients = [
        ...(mail.to
          ? (Array.isArray(mail.to) ? mail.to : [mail.to]).flatMap((a) =>
              a.value.map((v) => v.address ?? "")
            )
          : []),
        ...(mail.cc
          ? (Array.isArray(mail.cc) ? mail.cc : [mail.cc]).flatMap((a) =>
              a.value.map((v) => v.address ?? "")
            )
          : [])
      ].filter((addr) => addr.length > 0);

      return {
        externalId: key.id,
        threadId: null,
        historyId: null,
        subject: mail.subject ?? "(no subject)",
        from: mail.from?.text ?? "(unknown)",
        recipients,
        receivedAt: (mail.date ?? new Date()).toISOString(),
        labelIds: [],
        snippet: null,
        body: mail.text ?? (mail.html || ""),
        bodyTruncated: false,
        // Presence only: the parser already has every header, and the opt-out address in this
        // one is deliberately never read out or stored.
        hasListUnsubscribe: mail.headers?.has("list-unsubscribe") === true
      };
    });
  }
}
