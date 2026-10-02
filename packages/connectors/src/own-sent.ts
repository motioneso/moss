import type { DataContextDb } from "@moss/db";
import type { EmailRepository } from "@moss/email";

import { senderAddress, type EmailExtractResult, type ParsedEmail } from "./email-extract.js";
import { ownAddressSet } from "./email-sorting.js";

/**
 * #2878: mail the user sent from their own address is never owed a reply by the user. Sync
 * settles it before any model sees it, so neither sorter can mark it as waiting for a decision.
 */

/** The stored result for own-sent mail: no summary, no judgement, not a pending hand-off. */
export function ownSentResult(): EmailExtractResult {
  return { summary: null, signals: { skipped: "own_sent", confidence: 1 } };
}

/**
 * The user's own addresses. Also settles rows an earlier sync left marked as waiting, including
 * old ones a routine sync no longer fetches. Undefined when there is no actor.
 */
export async function loadOwnAddressesAndSettle(context: {
  readonly emailRepo: EmailRepository;
  readonly scopedDb: DataContextDb;
  readonly deps: { readonly actorUserId?: string | undefined };
}): Promise<ReadonlySet<string> | undefined> {
  const { emailRepo, scopedDb } = context;
  const actorUserId = context.deps.actorUserId;
  if (!actorUserId) return undefined;
  const addresses = ownAddressSet(
    await emailRepo.listFrequentRecipientAddresses(scopedDb, actorUserId)
  );
  await emailRepo.settleOwnSentAwaiting(scopedDb, actorUserId, addresses);
  return addresses;
}

/**
 * Saves a message sent by the user as settled. Returns false when it was not sent by the user.
 * An unchanged message that is not marked as waiting is left alone.
 */
export async function settleOwnSent(
  input: {
    readonly ownAddresses?: ReadonlySet<string> | undefined;
    readonly persistEmail: (parsed: ParsedEmail, extracted: EmailExtractResult) => Promise<unknown>;
  },
  parsed: ParsedEmail,
  state: { readonly unchanged: boolean; readonly awaiting: boolean },
  keys: { readonly settled: string[]; readonly unchanged: string[] },
  onFailure: (error: unknown) => void
): Promise<boolean> {
  if (!input.ownAddresses?.has(senderAddress(parsed.from))) return false;
  if (state.unchanged && !state.awaiting) {
    keys.unchanged.push(parsed.externalId);
    return true;
  }
  try {
    await input.persistEmail(parsed, ownSentResult());
    keys.settled.push(parsed.externalId);
  } catch (error) {
    onFailure(error);
  }
  return true;
}
