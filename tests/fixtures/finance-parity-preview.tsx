// Actual production Finance bundle, synthetic responses. Visual regression fixture only;
// this is deliberately not an installed live-path acceptance receipt.
import * as React from "react";
import * as ReactDom from "react-dom/client";

Object.assign(globalThis, {
  __JARVIS_MODULE_RUNTIME__: { contractVersion: 2, react: React, reactDomClient: ReactDom }
});
const date = new Date();
const fixture = new URL(location.href).searchParams.get("fixture");
const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const categories = [
  { id: "groceries", name: "Groceries" },
  { id: "dining", name: "Dining out" },
  { id: "income", name: "Income" }
];
const accounts = [
  {
    accountId: "checking",
    name: "Everyday checking",
    type: "depository",
    balanceCents: 1358023,
    isoCurrency: "USD"
  },
  {
    accountId: "card",
    name: "Household card",
    type: "credit",
    balanceCents: 123456,
    isoCurrency: "USD"
  },
  {
    accountId: "euro",
    name: "Travel reserve",
    type: "depository",
    balanceCents: 654321,
    isoCurrency: "EUR"
  }
].map((account) => ({ ...account, itemId: "synthetic-bank", mask: null }));
const rows = [
  {
    id: "market",
    name: "Weekend market",
    amountCents: 8243,
    categoryId: "groceries",
    accountId: "checking"
  },
  {
    id: "salary",
    name: "Monthly pay",
    amountCents: -420000,
    categoryId: "income",
    accountId: "checking"
  },
  {
    id: "coffee",
    name: "Corner coffee",
    amountCents: 1260,
    categoryId: "dining",
    accountId: "card",
    pending: true
  },
  {
    id: "duplicate-a",
    name: "Dinner with friends",
    amountCents: 6450,
    categoryId: "dining",
    accountId: "card",
    possibleDuplicate: true
  },
  {
    id: "duplicate-b",
    name: "Dinner with friends",
    amountCents: 6450,
    categoryId: "dining",
    accountId: "card",
    possibleDuplicate: true
  },
  {
    id: "review",
    name: "A new neighborhood shop with a long descriptive bank statement name",
    amountCents: 2431,
    categoryId: null,
    accountId: "checking",
    reviewState: "needs_look"
  }
].map((row) => ({
  date: `${month}-15`,
  isoCurrency: "USD",
  reviewState: "confirmed",
  pending: false,
  splitRevision: 0,
  splits: [] as { categoryId: string; amountCents: number }[],
  ...row
}));

window.fetch = async (input, init) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.includes("/queues/")) {
    const p = body.params;
    const row = rows.find((r) => r.id === p?.transactionId);
    if (row && url.includes("split-apply")) {
      row.splits = p.categoryIds.map((categoryId: string, i: number) => ({
        categoryId,
        amountCents: p.amountsCents[i]
      }));
      row.splitRevision += 1;
    }
    return Response.json({ jobId: "synthetic-job" }, { status: 202 });
  }
  if (fixture === "error") return Response.json({}, { status: 503 });
  if (fixture === "loading") await new Promise((resolve) => setTimeout(resolve, 60_000));
  const p = body.input ?? {};
  if (url.includes("/users/directory")) return Response.json({ users: [] });
  if (url.includes("finance.accounts.list"))
    return Response.json({
      invocation: {
        status: "succeeded",
        result: {
          accounts:
            fixture === "accounts-overflow"
              ? [
                  { ...accounts[0], balanceCents: Number.MAX_SAFE_INTEGER },
                  { ...accounts[1], type: "depository", balanceCents: 1 }
                ]
              : accounts,
          banks: [
            {
              itemId: "synthetic-bank",
              institutionId: "synthetic",
              institutionName: "Moss sample bank",
              status: "connected",
              lastSyncAt: date.toISOString(),
              message: null
            }
          ]
        }
      }
    });
  if (url.includes("finance.reports.")) {
    const currency = typeof p.currency === "string" ? p.currency : null;
    const scope = {
      window: [month],
      currency,
      currencies: ["EUR", "USD"],
      currencySelectionRequired: currency === null
    };
    const headlineCents = currency === "EUR" ? 654321 : 1234567;
    const outflowCents = currency === "EUR" ? 18423 : 8243;
    const result = url.includes("net-worth")
      ? {
          ...scope,
          points: currency ? [{ date: `${month}-15`, totalCents: headlineCents }] : [],
          headlineCents: currency ? headlineCents : null
        }
      : {
          ...scope,
          categories,
          shared: [],
          own: currency
            ? [
                {
                  month,
                  byCategory: { groceries: outflowCents },
                  byPayee: { "Weekend market": outflowCents },
                  cashFlow: { incomeCents: 420000, outflowCents, netCents: 420000 - outflowCents }
                }
              ]
            : []
        };
    return Response.json({ invocation: { status: "succeeded", result } });
  }
  const filtered =
    fixture === "empty"
      ? []
      : rows.filter(
          (r) =>
            (!p.accountId || p.accountId === r.accountId) &&
            (!p.transactionId || p.transactionId === r.id) &&
            (!p.categoryId || p.categoryId === r.categoryId) &&
            (!p.postingState || r.pending === (p.postingState === "pending")) &&
            (!p.direction || (p.direction === "inflow" ? r.amountCents < 0 : r.amountCents > 0)) &&
            (!p.duplicatesOnly || r.possibleDuplicate) &&
            (!p.uncategorizedOnly || r.categoryId === null) &&
            (!p.needsLookOnly || r.reviewState === "needs_look") &&
            (!p.search || r.name.toLowerCase().includes(p.search.toLowerCase()))
        );
  return Response.json({
    invocation: {
      status: "succeeded",
      result: {
        month,
        transactions: filtered,
        totalCount: filtered.length,
        needsLookCount: filtered.filter((r) => r.reviewState === "needs_look").length,
        accounts,
        categories,
        supportsSplits: true
      }
    }
  });
};

const entry = "/finance.js";
const { default: finance } = await import(entry);
const style = document.createElement("style");
style.textContent = finance.css;
document.head.append(style);
ReactDom.createRoot(document.getElementById("app")!).render(
  React.createElement(finance.Root, { hostActions: { openAssistant: () => {} } })
);
