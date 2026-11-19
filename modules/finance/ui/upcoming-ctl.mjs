/* global HTMLInputElement, HTMLSelectElement */
// Loads Upcoming and runs its actions. Every write sends the revision and fingerprint of the last read.
import { newOperationId } from "./html.mjs";
import { parseAmountToCents, shiftMonth, thisMonth } from "./format.mjs";
import { monthWindow, occurrenceBy, reviewOf } from "./upcoming-model.mjs";

const STALE =
  "The review changed or saving could not be confirmed. Use Check saved bills before trying again.";

export function createUpcoming({ api, root, render }) {
  const s = {
    month: thisMonth(),
    data: null,
    suggestions: [],
    error: false,
    message: "",
    busy: false,
    blocked: false,
    dialog: null
  };
  let seq = 0;

  const value = (name) => {
    const el = root.querySelector(`[data-field="${name}"]`);
    return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : "";
  };

  async function load(message = "") {
    const mine = ++seq;
    s.error = false;
    s.message = message;
    s.blocked = false;
    render();
    try {
      const { from, to } = monthWindow(s.month);
      const data = await api.call("GET", `/finance/bills?from=${from}&to=${to}`);
      const sug = data.setupRequired
        ? { suggestions: [] }
        : await api.call("GET", "/finance/bills/suggestions");
      if (mine !== seq) return;
      s.data = data;
      s.suggestions = sug.suggestions ?? [];
    } catch {
      if (mine === seq) {
        s.error = true;
        s.data = null;
      }
    }
    render();
  }

  /** Runs one write. A refused write asks for a fresh read, because the saved bills may have changed. */
  async function write(path, body, done) {
    s.busy = true;
    if (s.dialog) s.dialog.error = "";
    render();
    try {
      await api.call("POST", path, { ...reviewOf(s.data), ...body });
      s.busy = false;
      s.dialog = null;
      await load(done);
    } catch (error) {
      s.busy = false;
      if (error?.status === 400 && s.dialog) {
        s.dialog.error = error.detail || "Check the entry and try again.";
      } else {
        s.dialog = null;
        s.blocked = true;
        s.message = STALE;
      }
      render();
    }
  }

  const cents = (text) => {
    const c = parseAmountToCents(text);
    return Number.isInteger(c) && c > 0 ? c : null;
  };
  const bad = (text) => {
    s.dialog.error = text;
    render();
  };

  async function save() {
    const d = s.dialog;
    if (d.kind === "add") {
      const amount = cents(value("amount"));
      const name = value("name").trim();
      if (!name) return bad("Enter a bill name.");
      if (!amount) return bad("Enter an amount above zero.");
      Object.assign(d, {
        name,
        amount: value("amount"),
        accountId: value("accountId"),
        categoryId: value("categoryId"),
        cadence: value("cadence"),
        anchorDate: value("anchorDate")
      });
      return write(
        "/finance/bills",
        {
          id: newOperationId(),
          name,
          accountId: d.accountId,
          categoryId: d.categoryId,
          amountCents: amount,
          cadence: d.cadence,
          anchorDate: d.anchorDate
        },
        "Bill saved."
      );
    }
    if (d.kind === "stop") {
      return write(
        "/finance/bills/stop",
        { id: d.planId, endDate: value("endDate") },
        "Bill stopped."
      );
    }
    const o = occurrenceBy(s.data, d.key);
    if (!o) return bad("That bill is no longer on this list.");
    if (d.kind === "adjust") {
      const amount = cents(value("amount"));
      if (!amount) return bad("Enter an amount above zero.");
      return write(
        "/finance/bills/adjust",
        {
          planId: o.planId,
          dueDate: o.dueDate,
          plannedDate: value("plannedDate"),
          amountCents: amount
        },
        "Change saved."
      );
    }
    if (d.kind === "match") {
      const id =
        value("transactionId") || root.querySelector('[data-field="transactionId"]:checked')?.value;
      if (!id) return bad("Choose a charge.");
      return write(
        "/finance/bills/decide",
        { planId: o.planId, dueDate: o.dueDate, state: "matched", transactionId: id },
        "Bill matched."
      );
    }
  }

  function entryBody(o, d) {
    return {
      operationId: d.operationId,
      planId: o.planId,
      dueDate: o.dueDate,
      name: o.name,
      accountId: o.accountId,
      categoryId: o.categoryId,
      isoCurrency: s.data.isoCurrency,
      date: d.date,
      amountCents: cents(d.amount),
      cleared: true
    };
  }

  async function preview() {
    const d = s.dialog;
    const o = occurrenceBy(s.data, d.key);
    if (!o) return;
    if (!cents(value("amount"))) return bad("Enter an amount above zero.");
    Object.assign(d, {
      date: value("date"),
      amount: value("amount"),
      operationId: newOperationId()
    });
    d.busy = true;
    render();
    try {
      d.preview = await api.call("POST", "/finance/bills/entry-preview", {
        ...reviewOf(s.data),
        ...entryBody(o, d)
      });
      d.error = "";
    } catch (error) {
      d.error = error?.detail || "That entry could not be reviewed.";
    }
    d.busy = false;
    render();
  }

  const key = (el) => el.dataset.key;
  const open = (dialog) => {
    s.dialog = { error: "", busy: false, ...dialog };
    render();
  };

  /** Returns true when the action belongs to Upcoming. */
  function click(act, el) {
    switch (act) {
      case "bill-prev":
      case "bill-next":
        s.month = shiftMonth(s.month, act === "bill-next" ? 1 : -1);
        s.data = null;
        void load();
        return true;
      case "bill-reload":
        void load("Saved bills refreshed. Review the current records before saving.");
        return true;
      case "bill-add":
        return (open({ kind: "add" }), true);
      case "bill-stop":
        return (open({ kind: "stop", planId: el.dataset.plan }), true);
      case "bill-adjust":
        return (open({ kind: "adjust", key: key(el) }), true);
      case "bill-match":
        return (open({ kind: "match", key: key(el) }), true);
      case "bill-record":
        return (open({ kind: "record", key: key(el) }), true);
      case "bill-skip":
      case "bill-undo":
      case "bill-reset": {
        const o = occurrenceBy(s.data, key(el));
        if (!o) return true;
        const base = { planId: o.planId, dueDate: o.dueDate };
        if (act === "bill-skip")
          void write("/finance/bills/decide", { ...base, state: "skipped" }, "Occurrence skipped.");
        else if (act === "bill-undo") void write("/finance/bills/clear", base, "Review undone.");
        else void write("/finance/bills/adjust-reset", base, "One-off change reset.");
        return true;
      }
      case "sug-add":
      case "sug-dismiss": {
        const [payeeKey, accountId, cadence, amount] = el.dataset.sug.split("|");
        const sug = s.suggestions.find(
          (x) =>
            x.payeeKey === payeeKey &&
            x.accountId === accountId &&
            x.cadence === cadence &&
            String(x.amountCents) === amount
        );
        if (!sug) return true;
        if (act === "sug-dismiss") {
          s.busy = true;
          render();
          void api
            .call("POST", "/finance/bills/suggestions/dismiss", {
              accountId,
              payeeKey,
              cadence,
              amountCents: sug.amountCents
            })
            .then(() => ((s.busy = false), load("Suggestion dismissed.")))
            .catch(
              () => (
                (s.busy = false),
                (s.message = "That suggestion could not be dismissed."),
                render()
              )
            );
          return true;
        }
        void write(
          "/finance/bills",
          {
            id: newOperationId(),
            name: sug.name,
            accountId,
            categoryId: sug.categoryId ?? s.data.categories[0]?.id,
            amountCents: sug.amountCents,
            cadence,
            anchorDate: sug.nextDate
          },
          "Bill saved."
        );
        return true;
      }
      case "dialog-save":
        return (void save(), true);
      case "dialog-preview":
        return (void preview(), true);
      case "dialog-record": {
        const d = s.dialog;
        const o = occurrenceBy(s.data, d.key);
        if (o) void write("/finance/bills/entry-record", entryBody(o, d), "Bill entry recorded.");
        return true;
      }
      case "dialog-close":
        s.dialog = null;
        render();
        return true;
      default:
        return false;
    }
  }

  return {
    state: s,
    load,
    click,
    hasDialog: () => Boolean(s.dialog),
    closeDialog: () => ((s.dialog = null), render())
  };
}
