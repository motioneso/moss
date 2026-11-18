// Query building and display rules for the Transactions screen.
export const PAGE = 200;
export const MAX_PAGES = 10;

export const emptyFilters = () => ({
  accountId: "",
  categoryId: "",
  postingState: "",
  direction: "",
  ledgerState: "",
  check: ""
});

export const filterCount = (f) => Object.values(f).filter(Boolean).length;

export function requestParams(s) {
  const f = s.filters;
  return {
    month: s.month,
    search: s.search.trim(),
    accountId: f.accountId,
    categoryId: f.categoryId,
    postingState: f.postingState,
    direction: f.direction,
    ledgerState: f.ledgerState,
    uncategorizedOnly: f.check === "uncategorized",
    duplicatesOnly: f.check === "duplicates",
    needsLookOnly: s.view === "look",
    limit: PAGE * s.pages
  };
}

/** Plaid sign: positive is money out. */
export const isMoneyIn = (row) => row.amountCents < 0;

export const needsLook = (row) => row.reviewState === "needs_look" && !row.shared;

export function accountName(accounts, id) {
  return (accounts ?? []).find((a) => a.accountId === id)?.name ?? "";
}

export function categoryName(categories, id) {
  if (!id) return "";
  return (categories ?? []).find((c) => c.id === id)?.name ?? "";
}

/** Splits that do not add up to the amount deserve a warning badge. */
export function splitUnbalanced(row) {
  if (!Array.isArray(row.splits) || row.splits.length === 0) return false;
  const total = row.splits.reduce((sum, p) => sum + (p.amountCents ?? 0), 0);
  return total !== row.amountCents;
}
