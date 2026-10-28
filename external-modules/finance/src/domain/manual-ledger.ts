/** Bounded currencies until the general minor-unit storage migration is designed. */
export const MANUAL_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "CNY",
  "HKD",
  "SGD",
  "INR",
  "MXN"
] as const;
export const MANUAL_ACCOUNT_TYPES = [
  "checking",
  "savings",
  "cash",
  "credit",
  "loan",
  "asset"
] as const;
export type ManualAccountType = (typeof MANUAL_ACCOUNT_TYPES)[number];
export function manualAccountKind(type: ManualAccountType): { type: string; subtype: string } {
  if (type === "checking" || type === "savings") return { type: "depository", subtype: type };
  if (type === "credit") return { type: "credit", subtype: "credit card" };
  if (type === "loan") return { type: "loan", subtype: "loan" };
  return { type: "other", subtype: type };
}
export interface ManualAccountCreate {
  accountId: string;
  name: string;
  type: string;
  subtype: string;
  isoCurrency: string;
  openingDate: string;
  openingBalanceCents: number;
  digest: string;
  at: string;
}
export interface ManualEntryCreate {
  id: string;
  accountId: string;
  date: string;
  name: string;
  amountCents: number;
  isoCurrency: string;
  categoryId: string | null;
  notes: string;
  cleared: boolean;
  digest: string;
  at: string;
}
export type ManualWriteResult =
  | "created"
  | "unchanged"
  | "conflict"
  | "unavailable"
  | "invalid_date"
  | "overflow";
export interface ManualLedgerStore {
  createAccount(input: ManualAccountCreate): Promise<ManualWriteResult>;
  createEntry(input: ManualEntryCreate): Promise<ManualWriteResult>;
}
