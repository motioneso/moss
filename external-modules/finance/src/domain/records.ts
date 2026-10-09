// external-modules/finance/src/domain/records.ts
//
// FIN-01 (#1146) Task 3: stored record shapes (spec "Transaction record").
// Everything is plain JSON so records round-trip through the module KV
// unchanged, and field names are FIN-06-migration-friendly (they map 1:1
// onto future SQL columns). Money is integer cents, spending-positive —
// Plaid's float dollars are converted exactly once, at the reducer edge
// (Task 6 toRecord), never here.

export type ReviewState = "confirmed" | "needs_look";

export type TransactionRecord = {
  id: string;
  accountId: string;
  /** YYYY-MM-DD (Plaid's date; authorized date is deliberately not stored). */
  date: string;
  /** Integer cents, spending-positive (Plaid sign convention preserved). */
  amountCents: number;
  isoCurrency: string;
  name: string;
  merchant: string | null;
  /** Plaid personal_finance_category.primary, raw — input to the PFC map. */
  plaidCategory: string | null;
  categoryId: string | null;
  pending: boolean;
  /** Posted transactions carry their pending twin's id for de-duplication. */
  pendingTransactionId: string | null;
  categorizedBy: "rule" | "plaid-map" | "ai" | "user" | null;
  /**
   * #3175: "needs_look" rows still count toward their guessed category. Absent
   * reads as "confirmed" (rows written before review state existed).
   */
  reviewState?: ReviewState;
  /** 0 to 1; set only when the AI step chose the category. */
  aiConfidence?: number | null;
  /** Assistant-only free text — never in job payloads (metadata-only rule). */
  notes?: string;
};

/** One month-chunk value at monthKey(); sorted date desc, then id asc. */
export type TransactionChunk = { transactions: TransactionRecord[] };

export type AccountRecord = {
  accountId: string;
  itemId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balanceCents: number;
  isoCurrency: string;
  updatedAt: string;
  /**
   * FIN-04 (#1149) household opt-in. Absent = false: every account stays
   * private until its owner explicitly shares it (Private by default).
   */
  sharedToHousehold?: boolean;
};

export type ItemRecord = {
  itemId: string;
  institutionId: string | null;
  connectedAt: string;
  status: "connected" | "reauth-required" | "error";
  lastSyncAt?: string;
  /** Plaid error CODE only — never response bodies (secret hygiene). */
  lastError?: string;
  /** Plaid's type/code/message/request id for the last failure (#3161). */
  lastErrorDetail?: ItemErrorDetail;
};

export type ItemErrorDetail = {
  type: string | null;
  code: string;
  message: string | null;
  requestId: string | null;
};

/**
 * Pending Hosted Link session, stored at linkKey(linkToken). Deliberate
 * exception to "no tokens in KV": the LINK token is a short-lived,
 * non-secret session handle required for /link/token/get — access tokens
 * never appear here (they live only in the finance.plaid-tokens credential).
 */
export type LinkSessionRecord = {
  linkToken: string;
  hostedLinkUrl: string;
  createdAt: string;
  status: "pending" | "completed" | "abandoned";
};

/** One month of daily balance snapshots: YYYY-MM-DD -> balanceCents. */
export type SnapshotChunk = { days: Record<string, number> };
