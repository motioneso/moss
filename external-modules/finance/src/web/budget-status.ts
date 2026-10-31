// external-modules/finance/src/web/budget-status.ts
// The finance.budget.status result as the Budget screen reads it.
import type { CardPaymentView } from "./card-payments";
import type { FlexBudgetView } from "./flex-budget";
import type { TargetFundingLine } from "../domain/target-funding";
import type { TargetProgress } from "../domain/targets";

export interface BudgetCategory {
  id: string;
  name: string;
  archived?: boolean;
  tableGroup: string;
}

export interface CategoryState {
  assignedCents: number;
  activityCents: number;
  availableCents: number;
}

export interface BudgetAccount {
  accountId: string;
  name: string;
  balanceCents: number | null;
  isoCurrency: string;
  asOf: string | null;
  stale: boolean;
}

export interface BudgetStatusResult extends Record<string, unknown> {
  month: string;
  cardPayments?: CardPaymentView[];
  cardChoices?: { accountId: string; name: string }[];
  cardStorageReady?: boolean;
  cardLedgerReviewRequired?: boolean;
  targets?: TargetProgress[];
  targetFunding?: TargetFundingLine[];
  targetFundingOverspent?: boolean;
  flex?: FlexBudgetView["flex"];
  flexChoices?: FlexBudgetView["flexChoices"];
  flexDetail?: FlexBudgetView["flexDetail"];
  currentMonth?: string;
  revision?: number;
  fingerprint?: string;
  isoCurrency?: string | null;
  setupRequired?: boolean;
  storageReady?: boolean;
  legacyMonthCount?: number;
  legacyDraft?: boolean;
  legacyMonths?: { month: string; totalCents: string }[];
  currencies?: string[];
  accountCurrencies?: string[];
  readyUnavailable?: string | null;
  pendingCount?: number;
  excludedAccountCount?: number;
  futureReservedCents?: number;
  state?: { categories: Record<string, CategoryState> };
  categories?: BudgetCategory[];
  accounts?: BudgetAccount[];
  hasBank?: boolean;
  hasBudget?: boolean;
  readyToAssignCents?: number | null;
  needsLookCount?: number;
}
