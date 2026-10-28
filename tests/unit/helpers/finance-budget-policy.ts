import type {
  BudgetPolicyStore,
  AccountRecord
} from "../../../external-modules/finance/src/domain/index.js";

/** Explicit configured-policy fixture; production KV storage still cannot configure a budget. */
export const usdBudgetPolicy: BudgetPolicyStore = {
  get: async () => ({ isoCurrency: "USD", createdAt: "2026-01-01T00:00:00Z", revision: 0 }),
  configure: async () => {
    throw new Error("configuration is outside this unit fixture");
  }
};
export const budgetAccountFixture = (accountId: string): AccountRecord => ({
  accountId,
  itemId: null,
  name: "Synthetic checking",
  officialName: null,
  type: "depository",
  subtype: "checking",
  mask: null,
  balanceCents: 0,
  isoCurrency: "USD",
  updatedAt: "2026-07-01T00:00:00Z"
});
