import {
  kvStore,
  NS,
  DEFAULT_CATEGORIES,
  type FinanceKv,
  type Category,
  type FinanceStore,
  type BudgetPolicyStore,
  type AccountRecord
} from "../../../external-modules/finance/src/domain/index.js";

export const budgetReview = { revision: 0, fingerprint: "a".repeat(32) };
export const budgetReviewInput = {
  expectedRevision: budgetReview.revision,
  expectedFingerprint: budgetReview.fingerprint
};
/** Explicit configured-policy fixture; production KV storage still cannot configure a budget. */
export const usdBudgetPolicy: BudgetPolicyStore = {
  get: async () => ({
    isoCurrency: "USD",
    createdAt: "2026-01-01T00:00:00Z",
    ...budgetReview,
    taxonomyReady: true
  }),
  categories: async () => null,
  initializeCategories: async () => {
    throw new Error("migration is outside this unit fixture");
  },
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

/** Unit-only storage stand-in. Real atomicity and revisions are tested against installed SQL. */
export function configuredBudgetStore(kv: FinanceKv): FinanceStore {
  const base = kvStore(kv);
  return {
    ...base,
    budgetPolicy: usdBudgetPolicy,
    async commitBudgetChange(change) {
      const applied = await base.commitBudgetChange.call(this, change);
      if (applied && change.categories?.length) {
        const stored = (await kv.get(NS.categories, "taxonomy")) as {
          categories: Category[];
        } | null;
        const all = new Map((stored?.categories ?? DEFAULT_CATEGORIES).map((c) => [c.id, c]));
        for (const category of change.categories) all.set(category.id, category);
        await kv.set(NS.categories, "taxonomy", { categories: [...all.values()] });
      }
      return applied;
    }
  };
}
