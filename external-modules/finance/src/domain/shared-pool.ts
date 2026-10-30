// external-modules/finance/src/domain/shared-pool.ts
//
// FIN-04 (#1149): pure projection of an owner's finance data into the
// instance-scoped `finance.shared` household mirror. The mirror is a
// projection, never a source of truth — the owner's user-scoped records stay
// authoritative and the mirror is safe to delete wholesale.
//
// Every projector here is an explicit field ALLOWLIST (same guard posture as
// the LLM-field exfiltration defense): fields are copied one by one, never
// spread, so an unknown extra field on a stored record can never leak into
// the mirror. `notes` is assistant-only personal annotation and is dropped
// even on shared accounts; `itemId` and item status are Plaid plumbing the
// household never needs.

import type { AccountRecord, TransactionChunk, TransactionRecord } from "./records.js";

/** The subset of an owner's AccountRecord a household member may see. */
export type SharedAccountMeta = {
  accountId: string;
  ownerUserId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balanceCents: number;
  isoCurrency: string;
  updatedAt: string;
};

export function toSharedAccountMeta(
  ownerUserId: string,
  account: AccountRecord
): SharedAccountMeta {
  return {
    accountId: account.accountId,
    ownerUserId,
    name: account.name,
    officialName: account.officialName,
    type: account.type,
    subtype: account.subtype,
    mask: account.mask,
    balanceCents: account.balanceCents,
    isoCurrency: account.isoCurrency,
    updatedAt: account.updatedAt
  };
}

// Exported for the merged household read (#1149 Task 5): transactions.query
// re-applies this allowlist when copying mirror rows into a response, so a
// malformed mirror write can never leak extra fields to another user.
export function toSharedTransaction(transaction: TransactionRecord): TransactionRecord {
  // Allowlist copy — deliberately NOT `{ ...transaction }` minus `notes`;
  // a field added to TransactionRecord later must be shared on purpose.
  return {
    id: transaction.id,
    ...(transaction.transferId ? { transferId: transaction.transferId } : {}),
    accountId: transaction.accountId,
    date: transaction.date,
    amountCents: transaction.amountCents,
    isoCurrency: transaction.isoCurrency,
    name: transaction.name,
    merchant: transaction.merchant,
    plaidCategory: transaction.plaidCategory,
    categoryId: transaction.categoryId,
    pending: transaction.pending,
    pendingTransactionId: transaction.pendingTransactionId,
    categorizedBy: transaction.categorizedBy,
    ...(transaction.splits?.length
      ? {
          splits: transaction.splits.map((split) => ({
            categoryId: split.categoryId,
            amountCents: split.amountCents
          }))
        }
      : {})
  };
}

/** Project a user-scoped month chunk into its mirror shape (`notes` stripped). */
export function toSharedChunk(chunk: TransactionChunk): TransactionChunk {
  return { transactions: chunk.transactions.map(toSharedTransaction) };
}

// Mirror key contract: `{ownerUserId}:{accountId}:{suffix}` where suffix is
// `meta` or `YYYY-MM`. Owner ids are UUIDs and account ids are the module's
// own minted identifiers — neither contains `:`, so splitting on the first
// two colons is unambiguous.

export function sharedMetaKey(ownerUserId: string, accountId: string): string {
  return `${ownerUserId}:${accountId}:meta`;
}

export function sharedMonthKey(ownerUserId: string, accountId: string, month: string): string {
  return `${ownerUserId}:${accountId}:${month}`;
}

/** Prefix covering every mirror key for one shared account (unshare deletes this). */
export function sharedAccountPrefix(ownerUserId: string, accountId: string): string {
  return `${ownerUserId}:${accountId}:`;
}

/** Prefix covering one owner's whole mirror (sync reconcile scans this). */
export function sharedOwnerPrefix(ownerUserId: string): string {
  return `${ownerUserId}:`;
}

export type ParsedSharedKey = {
  ownerUserId: string;
  accountId: string;
  suffix: string;
};

/** Parse a mirror key; null for anything that doesn't match the contract. */
export function parseSharedKey(key: string): ParsedSharedKey | null {
  const first = key.indexOf(":");
  if (first <= 0) {
    return null;
  }
  const second = key.indexOf(":", first + 1);
  if (second <= first + 1) {
    return null;
  }
  const suffix = key.slice(second + 1);
  if (suffix.length === 0) {
    return null;
  }
  return {
    ownerUserId: key.slice(0, first),
    accountId: key.slice(first + 1, second),
    suffix
  };
}
