import type { EmailMessage } from "@moss/db";
import type { EmailThreadMessage, EmailThreadProvider } from "@moss/module-sdk";

import type { EmailRepository } from "./repository.js";

/** Longest body excerpt handed to the thread judgement, per message. */
export const THREAD_EXCERPT_CAP = 4_000;

/** The bare, lower-cased address from a sender header such as `Sarah Kim <Sarah@Kim.Example>`. */
export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

/**
 * Exposes a cached email thread to the Commitments module through the shared contract, so the
 * second pass can read a whole thread without touching the email tables itself. Bodies never
 * leave this shape: the excerpt is what the cache already holds, capped again here.
 */
export function createEmailThreadProvider(
  repo: Pick<EmailRepository, "listByThread" | "listNewerInThreads" | "getByOwnerAndExternalId">,
  userAddressesFor: (scopedDb: unknown, ownerUserId: string) => Promise<ReadonlySet<string>>
): EmailThreadProvider {
  const map = (m: EmailMessage, mine: ReadonlySet<string>): EmailThreadMessage => {
    const address = senderAddress(m.sender);
    return {
      externalId: m.external_id,
      cacheMessageId: m.id,
      fromAddress: address,
      fromIsUser: mine.has(address),
      subject: m.subject ?? "",
      receivedAt: new Date(m.received_at).toISOString(),
      bodyExcerpt: (m.body_excerpt ?? "").slice(0, THREAD_EXCERPT_CAP)
    };
  };
  return {
    async listThreadMessages(scopedDb, actorUserId, threadRef) {
      const mine = await userAddressesFor(scopedDb, actorUserId);
      const rows = await repo.listByThread(scopedDb as never, actorUserId, threadRef);
      if (rows.length > 0) return rows.map((m) => map(m, mine));
      // No provider thread id matched: the reference may be a single message id (IMAP).
      const single = await repo.getByOwnerAndExternalId(scopedDb as never, actorUserId, threadRef);
      return single ? [map(single, mine)] : [];
    },
    async listThreadsWithNewerMessages(scopedDb, actorUserId, threads) {
      const mine = await userAddressesFor(scopedDb, actorUserId);
      const rows = await repo.listNewerInThreads(
        scopedDb as never,
        actorUserId,
        threads.map((t) => ({ threadId: t.threadRef, afterExternalId: t.afterExternalId }))
      );
      return rows.map((r) => ({ threadRef: r.threadId, newest: map(r.message, mine) }));
    }
  };
}
