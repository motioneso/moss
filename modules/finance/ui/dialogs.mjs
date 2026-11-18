// The two small dialogs the Accounts screen opens. Both save through the manual routes.
import { centsToAmountInput, parseAmountToCents } from "./format.mjs";
import { button, dialogHtml, esc, newOperationId } from "./html.mjs";

const TYPES = [["checking", "Checking"], ["savings", "Savings"], ["cash", "Cash"], ["credit", "Credit card"], ["loan", "Loan"], ["asset", "Other asset"]];

export function accountDialog(d, ctx) {
  const currencies = (ctx?.currencies ?? ["USD"]).map((c) => `<option value="${esc(c)}"${(d.isoCurrency ?? ctx?.defaultCurrency ?? "USD") === c ? " selected" : ""}>${esc(c)}</option>`).join("");
  const body = `<form class="fnm-manual-form" data-form="account"><label>Name<input class="jds-input" name="name" required value="${esc(d.name ?? "")}"></label><label>Type<select class="jds-select" name="accountType">${TYPES.map(([v, t]) => `<option value="${v}"${d.accountType === v ? " selected" : ""}>${t}</option>`).join("")}</select></label><label>Currency<select class="jds-select" name="isoCurrency">${currencies}</select></label><label>Opening balance<input class="jds-input" name="opening" inputmode="decimal" value="${esc(d.opening ?? "0.00")}"></label>${d.error ? `<p role="alert" class="jds-hint">${esc(d.error)}</p>` : ""}</form>`;
  return dialogHtml({ title: "Add manual account", body, footer: `${button("Cancel", { act: "dialog-close", size: "md" })}${button(d.busy ? "Saving…" : "Add account", { act: "dialog-save", variant: "primary", size: "md", disabled: d.busy })}` });
}

export function entryDialog(d, ctx) {
  const cats = (ctx?.categories ?? []).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  const body = `<form class="fnm-manual-form" data-form="entry"><label>Payee<input class="jds-input" name="name" required value="${esc(d.name ?? "")}"></label><label>Amount<input class="jds-input" name="amount" inputmode="decimal" placeholder="12.50" value="${esc(d.amount ?? "")}"></label><label>Direction<select class="jds-select" name="direction"><option value="out">Money out</option><option value="in"${d.direction === "in" ? " selected" : ""}>Money in</option></select></label><label>Date<input class="jds-input" type="date" name="date" value="${esc(d.date ?? ctx?.today ?? "")}"></label><label>Category<select class="jds-select" name="categoryId"><option value="">Uncategorized</option>${cats}</select></label>${d.error ? `<p role="alert" class="jds-hint">${esc(d.error)}</p>` : ""}</form>`;
  return dialogHtml({ title: `Add transaction to ${d.accountName}`, body, footer: `${button("Cancel", { act: "dialog-close", size: "md" })}${button(d.busy ? "Saving…" : "Add transaction", { act: "dialog-save", variant: "primary", size: "md", disabled: d.busy })}` });
}

/** The request body for a filled-in form, or a plain-words problem. */
export function accountRequest(form, ctx) {
  const name = form.name.trim();
  if (!name) return { problem: "Enter a name for the account." };
  const opening = parseAmountToCents(form.opening || "0");
  if (opening === null) return { problem: "Enter an opening balance like 250 or 250.50." };
  const debt = form.accountType === "credit" || form.accountType === "loan";
  return {
    body: { operationId: newOperationId(), name, accountType: form.accountType, isoCurrency: form.isoCurrency || ctx?.defaultCurrency || "USD", openingDate: ctx?.today, openingBalanceCents: debt ? Math.abs(opening) : opening }
  };
}

export function entryRequest(form, d, ctx) {
  const name = form.name.trim();
  if (!name) return { problem: "Enter a payee." };
  const cents = parseAmountToCents(form.amount);
  if (cents === null || cents === 0) return { problem: "Enter an amount like 12 or 12.50." };
  const out = form.direction !== "in";
  return {
    body: {
      operationId: newOperationId(), accountId: d.accountId, name,
      amountCents: out ? Math.abs(cents) : -Math.abs(cents),
      ...(form.categoryId ? { categoryId: form.categoryId } : {}), isoCurrency: d.isoCurrency, date: form.date || ctx?.today, notes: "", cleared: true
    }
  };
}

export { centsToAmountInput };
