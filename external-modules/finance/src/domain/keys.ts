// external-modules/finance/src/domain/keys.ts
//
// FIN-01 (#1146) Task 3: deterministic KV addressing (grounded-decisions
// "KV/key design"). Keys carry ids, months, and hashes only — never tokens,
// payee prose, or amounts — so key listings can't leak private content. The
// shapes below are a storage contract: every later slice (sync reducer,
// feed queries, rules) re-derives them, so changing one orphans stored data.
import { createHash } from "node:crypto";

import { FinanceKvError } from "./errors.js";

// 32 hex chars = 128 bits of sha256 (job-search keys.ts precedent) —
// collision-safe at personal-finance scale.
function sha256Hex32(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

/** Hash used for link-session keys and (FIN-02) rule keys. */
export function contentHash(value: string): string {
  return sha256Hex32(value);
}

const ISO_DATE = /^(\d{4})-(\d{2})-\d{2}$/;

function monthOf(isoDate: string): { year: number; month: number } {
  const match = ISO_DATE.exec(isoDate);
  if (!match) {
    // Deliberately does not echo the value — a malformed "date" from a
    // provider payload could be arbitrary content.
    throw new FinanceKvError("invalid_record", "date must be YYYY-MM-DD");
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** Month-chunk key for transactions/snapshots: "acc1:2026-07". */
export function monthKey(accountId: string, isoDate: string): string {
  const { year, month } = monthOf(isoDate);
  return `${accountId}:${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Previous month's chunk key — the reducer probes it for a posted
 * transaction's pending twin that landed late in the prior month.
 */
export function prevMonthKey(accountId: string, isoDate: string): string {
  const { year, month } = monthOf(isoDate);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${accountId}:${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

/** Connection item record key in finance.connections. */
export function itemKey(itemId: string): string {
  return `item:${itemId}`;
}

/**
 * Sync cursor key — separate from itemKey so persisting the cursor LAST
 * (after its page's chunks are written) stays a single isolated write.
 */
export function cursorKey(itemId: string): string {
  return `cursor:${itemId}`;
}

/**
 * Pending link-session key. The link token is hashed so the token itself
 * never becomes key material (keys appear in listings and logs).
 */
export function linkKey(linkToken: string): string {
  return `link:${contentHash(linkToken)}`;
}

/**
 * Payee normalization for categorization rules (FIN-02): lowercase, strip
 * digits and punctuation, collapse whitespace runs — "Trader Joe's #123 "
 * and "TRADER JOES 456" both key the same rule.
 */
export function normalizePayee(name: string): string {
  return name
    .toLowerCase()
    .replace(/[0-9]/gu, "")
    .replace(/[^\p{L}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Current key for a merchant rule. */
export function ruleKey(payeeKey: string): string {
  return `rule:${contentHash(payeeKey)}`;
}

/** Older rules were stored under the bare hash. Still read, never written. */
export function legacyRuleKey(payeeKey: string): string {
  return contentHash(payeeKey);
}
