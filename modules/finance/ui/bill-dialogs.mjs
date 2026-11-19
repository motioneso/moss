// Dialog markup for the bill actions on Upcoming. Fields carry data-field so the controller can read them.
import { esc, button, dialogHtml, note } from "./html.mjs";
import { formatCents, shortDayLabel, centsToAmountInput } from "./format.mjs";
import { cadenceLabel, occurrenceBy, occurrenceDate } from "./upcoming-model.mjs";

const field = (label, control) =>
  `<label class="jds-field"><span class="jds-field__label">${esc(label)}</span>${control}</label>`;
const input = (name, value = "", type = "text", extra = "") =>
  `<input class="jds-input" data-field="${name}" type="${type}" value="${esc(value)}"${extra}>`;
const select = (name, options, value) =>
  `<select class="jds-select" data-field="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

const foot = (d, confirm, act) =>
  `${button("Cancel", { act: "dialog-close", variant: "quiet" })}${button(confirm, { act, variant: "primary", disabled: d.busy })}`;
const error = (d) => (d.error ? note("danger", d.error) : "");

function addBill(d, v) {
  const body = `${field("Bill name", input("name", d.name ?? "", "text", ' maxlength="160"'))}${field(
    "Account",
    select(
      "accountId",
      v.accounts.map((a) => [a.accountId, a.name]),
      d.accountId ?? v.accounts[0]?.accountId
    )
  )}${field(
    "Category",
    select(
      "categoryId",
      v.categories.map((c) => [c.id, c.name]),
      d.categoryId ?? v.categories[0]?.id
    )
  )}${field("Amount", input("amount", d.amount ?? "", "text", ' inputmode="decimal"'))}${field(
    "How often",
    select(
      "cadence",
      ["once", "weekly", "fortnightly", "monthly", "yearly"].map((c) => [c, cadenceLabel(c)]),
      d.cadence ?? "monthly"
    )
  )}${field("First due date", input("anchorDate", d.anchorDate ?? v.today, "date"))}${error(d)}`;
  return dialogHtml({ title: "Add a bill", body, footer: foot(d, "Save bill", "dialog-save") });
}

function stopBill(d, v) {
  const plan = v.plans.find((p) => p.id === d.planId);
  const body = `<p>${esc(plan?.name ?? "This bill")} stops after the date you choose. Earlier bills stay.</p>${field("Last bill date", input("endDate", d.endDate ?? v.today, "date"))}${error(d)}`;
  return dialogHtml({
    title: "Stop future bills",
    body,
    footer: foot(d, "Stop bill", "dialog-save")
  });
}

function adjust(d, v) {
  const o = occurrenceBy(v, d.key);
  const body = `<p>${esc(o?.name ?? "")}, usually due ${esc(o ? shortDayLabel(o.dueDate) : "")}. This change applies to this one bill only.</p>${field("New date", input("plannedDate", d.plannedDate ?? (o ? occurrenceDate(o) : ""), "date"))}${field("Expected amount", input("amount", d.amount ?? (o ? centsToAmountInput(o.expectedCents) : ""), "text", ' inputmode="decimal"'))}${error(d)}`;
  return dialogHtml({
    title: "Change this occurrence",
    body,
    footer: foot(d, "Save change", "dialog-save")
  });
}

function match(d, v) {
  const o = occurrenceBy(v, d.key);
  const rows = v.transactions.length
    ? v.transactions
        .map(
          (t) =>
            `<label class="fnm-row"><input type="radio" name="tx" data-field="transactionId" value="${esc(t.id)}"${t.id === d.transactionId ? " checked" : ""}><span class="fnm-txmain"><strong>${esc(t.name)}</strong><span class="jds-hint">${esc(shortDayLabel(t.date))}</span></span><span class="fnm-money">${formatCents(t.amountCents, v.isoCurrency)}</span></label>`
        )
        .join("")
    : `<p class="jds-hint">No posted charges near this date.</p>`;
  const body = `<p>Pick the posted charge that paid ${esc(o?.name ?? "this bill")}.</p>${rows}${error(d)}`;
  return dialogHtml({ title: "Match posted", body, footer: foot(d, "Match", "dialog-save") });
}

function record(d, v) {
  const o = occurrenceBy(v, d.key);
  const p = d.preview;
  const form = `${field("Date", input("date", d.date ?? (o ? occurrenceDate(o) : v.today), "date", p ? " disabled" : ""))}${field("Amount", input("amount", d.amount ?? (o ? centsToAmountInput(o.expectedCents) : ""), "text", ` inputmode="decimal"${p ? " disabled" : ""}`))}`;
  const review = p
    ? `<dl class="fnm-report-month"><dt>Account</dt><dd>${esc(p.accountName)}</dd><dt>Balance now</dt><dd>${formatCents(p.beforeCents, v.isoCurrency)}</dd><dt>Balance after</dt><dd>${formatCents(p.afterCents, v.isoCurrency)}</dd></dl>${p.canRecord ? "" : note("warning", "A matching charge already exists. Use Match posted instead.")}`
    : "";
  const confirm = p ? "Record entry" : "Review entry";
  const foot2 = `${button("Cancel", { act: "dialog-close", variant: "quiet" })}${button(confirm, { act: p ? "dialog-record" : "dialog-preview", variant: "primary", disabled: d.busy || (p && !p.canRecord) })}`;
  return dialogHtml({
    title: "Record bill entry",
    body: `${form}${review}${error(d)}`,
    footer: foot2
  });
}

export function billDialog(d, v) {
  switch (d.kind) {
    case "add":
      return addBill(d, v);
    case "stop":
      return stopBill(d, v);
    case "adjust":
      return adjust(d, v);
    case "match":
      return match(d, v);
    case "record":
      return record(d, v);
    default:
      return "";
  }
}
