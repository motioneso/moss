import {
  Button,
  Dialog,
  Note,
  Switch,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { BillsView, Occurrence } from "./screens/upcoming";
import { isCalendarDate } from "../domain/values";
import { centsToAmountInput, formatCents } from "./format";
import { parseLedgerAmount } from "./manual-entry";
import { invalidateQueries } from "./store";
interface Preview extends Record<string, unknown> {
  revision: number;
  fingerprint: string;
  accountName: string;
  categoryName: string;
  beforeCents: number;
  afterCents: number;
  debt: boolean;
  expectedCents: number;
  canRecord: boolean;
  candidateCount: number;
  candidates: { id: string; date: string; name: string; amountCents: number }[];
}
export function BillEntryDialog(props: {
  data: BillsView;
  occurrence: Occurrence;
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
  onUncertain: () => void;
}): ReactNodeLike {
  const [data] = useState(props.data),
    [bill] = useState(props.occurrence);
  const [operationId] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(bill.plannedDate ?? bill.dueDate);
  const [amount, setAmount] = useState(centsToAmountInput(bill.expectedCents));
  const [cleared, setCleared] = useState(false),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [review, setReview] = useState<{ input: Record<string, unknown>; preview: Preview } | null>(
    null
  );
  const lock = useRef(false);
  const cents = parseLedgerAmount(amount);
  const valid = cents !== null && cents > 0 && isCalendarDate(date) && date <= data.today;
  const money = (value: number) => formatCents(value, data.isoCurrency);
  const close = () => {
    if (!lock.current) props.onClose();
  };
  const inspect = async () => {
    if (!valid || !props.tools || lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    const input = {
      operationId,
      planId: bill.planId,
      dueDate: bill.dueDate,
      accountId: bill.accountId,
      categoryId: bill.categoryId,
      name: bill.name,
      isoCurrency: data.isoCurrency,
      date,
      amountCents: cents,
      cleared,
      expectedRevision: data.revision,
      expectedFingerprint: data.fingerprint
    };
    try {
      const result = await props.tools.invoke("finance.bill.entry-preview", input);
      if (result.status === "succeeded" && result.result.status === "ok") {
        setReview({ input, preview: result.result as Preview });
      } else {
        const code = result.status === "rejected" ? result.moduleCode : "";
        const errors: Record<string, string> = {
          stale_budget: "The bill or ledger changed. Close this form and check saved bills.",
          bill_entry_period:
            "Choose a date after the last reconciled statement and on or after account opening.",
          bill_entry_account:
            "Check that the bill uses an active manual account with a valid ledger in this currency.",
          bill_not_due: "This occurrence is not due yet. Keep it as a projection.",
          bill_already_reviewed: "Check this bill's existing match or skipped review first.",
          invalid_category: "Use a current expense category on the bill.",
          bill_entry_overflow:
            "The resulting balance exceeds supported precision. Nothing was recorded."
        };
        setMessage(
          errors[code ?? ""] ??
            "Could not load the review. Check the bill and saved account before trying again."
        );
      }
    } catch {
      setMessage("Could not load the review. Check your connection and try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const save = async () => {
    if (!review?.preview.canRecord || !props.tools || blocked || lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools.invoke("finance.bill.entry-record", review.input);
      if (result.status === "succeeded" && result.result.status === "ok") {
        invalidateQueries();
        props.onClose();
      } else if (result.status === "cancelled")
        setMessage("Cancelled. Your captured entry review is kept.");
      else {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          "The review changed or recording could not be confirmed. Close this review and check saved bills and Transactions before trying again."
        );
      }
    } catch {
      setBlocked(true);
      props.onUncertain();
      setMessage(
        "Recording could not be confirmed. Check saved bills and Transactions before starting another entry."
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={review ? "Review bill entry" : "Record bill entry"}
      scrollBody
      closeLabel="Close"
      closeDisabled={busy}
      onClose={close}
      description={`${bill.name} · ${data.isoCurrency} · originally ${bill.dueDate}`}
      footer={
        <div className="fnm-spread">
          <Button variant="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {review ? (
            <>
              <Button
                variant="secondary"
                disabled={busy || blocked}
                onClick={() => {
                  setReview(null);
                  setMessage(null);
                }}
              >
                Edit entry
              </Button>
              <Button
                disabled={busy || blocked || !review.preview.canRecord || !props.tools}
                onClick={() => void save()}
              >
                {busy ? "Recording…" : "Confirm record entry"}
              </Button>
            </>
          ) : (
            <Button disabled={!valid || busy || !props.tools} onClick={() => void inspect()}>
              {busy ? "Reviewing…" : "Review entry"}
            </Button>
          )}
        </div>
      }
    >
      <div className="fnm-block">
        <Note variant="practical">
          Record an expense that already happened. This adds a transaction in Moss and matches this
          bill; no bank payment is sent.
        </Note>
        {review ? (
          <>
            <dl className="fnm-block fnm-block--tight">
              <div>
                <dt>{review.preview.debt ? "Amount owed after" : "Balance after"}</dt>
                <dd>
                  <strong>{money(review.preview.afterCents)}</strong>
                </dd>
              </div>
              <div>
                <dt>{review.preview.debt ? "Amount owed before" : "Balance before"}</dt>
                <dd>{money(review.preview.beforeCents)}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{review.preview.accountName}</dd>
              </div>
              <div>
                <dt>Category</dt>
                <dd>{review.preview.categoryName}</dd>
              </div>
              <div>
                <dt>Actual expense</dt>
                <dd>
                  {money(cents!)} · {date} · {cleared ? "Cleared" : "Not yet cleared"}
                </dd>
              </div>
              <div>
                <dt>Bill expected</dt>
                <dd>{money(review.preview.expectedCents)}</dd>
              </div>
            </dl>
            {!review.preview.canRecord ? (
              <Note variant="practical">
                Review existing expenses first. {review.preview.candidateCount} posted expense(s)
                with this amount exist within seven days. Close and use Match posted. For a
                genuinely separate expense, record it in Accounts first, then match it.
              </Note>
            ) : null}
            {review.preview.candidates.length ? (
              <ul>
                {review.preview.candidates.map((t) => (
                  <li key={t.id}>
                    {t.date} · {t.name} · {money(t.amountCents)}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <>
            <p>
              {data.accounts.find((a) => a.accountId === bill.accountId)?.name} ·{" "}
              {data.categories.find((c) => c.id === bill.categoryId)?.name}
            </p>
            <label className="fnm-block fnm-block--tight">
              Actual expense date
              <input
                className="jds-input"
                aria-label="Bill entry date"
                type="date"
                value={date}
                max={data.today}
                disabled={busy}
                onChange={(e: { currentTarget: { value: string } }) =>
                  setDate(e.currentTarget.value)
                }
              />
            </label>
            <label className="fnm-block fnm-block--tight">
              Actual amount ({data.isoCurrency})
              <input
                className="jds-input"
                aria-label="Bill entry amount"
                inputMode="decimal"
                value={amount}
                disabled={busy}
                onChange={(e: { currentTarget: { value: string } }) =>
                  setAmount(e.currentTarget.value)
                }
              />
            </label>
            <Switch
              ariaLabel="Bill expense cleared"
              label="Cleared on your statement"
              checked={cleared}
              disabled={busy}
              onChange={setCleared}
            />
            <p className="jds-hint">
              Use a decimal point and at most two decimal places. Dates inside reconciled statements
              cannot be changed.
            </p>
          </>
        )}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </Dialog>
  );
}
