import {
  Button,
  Dialog,
  Select,
  randomUuid,
  Switch,
  useEffect,
  useState,
  type ExternalModuleToolsHandleV1,
  type ModuleToolOutcome,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { decimalToCents, isCalendarDate } from "../domain/values";
import { MANUAL_ACCOUNT_TYPES, MANUAL_CURRENCIES } from "../domain/manual-ledger";
import { formatCents } from "./format";
import { invalidateQueries } from "./store";

export interface ManualAccountChoice {
  accountId: string;
  name: string;
  isoCurrency: string;
  type: string;
  openingDate?: string;
}
interface Context {
  today: string;
  supported: boolean;
  categories: { id: string; name: string }[];
}
export function parseLedgerAmount(text: string): number | null {
  // The form labels its currency explicitly; reject grouping ambiguity and sub-cent input.
  if (!/^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text.trim())) return null;
  try {
    return decimalToCents(text.trim());
  } catch {
    return null;
  }
}
export function manualSaveMessage(outcome: ModuleToolOutcome): string | null {
  if (outcome.status === "succeeded" && outcome.result.status === "ok") return null;
  if (outcome.status === "cancelled") return "Cancelled. Your entries are kept.";
  const code = outcome.status === "rejected" ? outcome.moduleCode : undefined;
  const messages: Record<string, string> = {
    future_date:
      "Choose today or an earlier date in your Moss timezone. Future bills need a scheduled entry.",
    manual_invalid_date: "Choose a date on or after this account's opening balance.",
    manual_reconciled_period:
      "This statement period is reconciled. Choose a date after the last reconciled statement.",
    manual_unavailable:
      "This account is unavailable or its currency changed. Refresh accounts before continuing.",
    manual_conflict:
      "This save identity already belongs to another entry. Check your saved records before starting a new entry.",
    manual_overflow: "This would take the balance beyond supported precision. Nothing was added.",
    invalid_category: "Choose a current category. Linked transfers are not available in this form.",
    storage_upgrade_required: "Finance storage needs an update before manual entry is available.",
    timezone_required: "Update Moss to supply your timezone before recording an entry.",
    unsupported_currency: "Choose one of the supported two-decimal currencies."
  };
  if (code && messages[code]) return messages[code]!;
  if (outcome.status === "invalid_input" || code === "invalid_input")
    return "Check the required fields and use no more than two decimal places.";
  return "Saving could not be confirmed. Your entries are kept. Refresh saved records and check whether this entry was added before starting another.";
}
const TYPE_LABELS: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit: "Credit card",
  loan: "Loan",
  asset: "Other asset"
};

export function ManualEntryDialog(props: {
  tools?: ExternalModuleToolsHandleV1;
  account?: ManualAccountChoice;
  onClose: () => void;
  onSaved: () => void;
}): ReactNodeLike {
  const [operationId] = useState(() => randomUuid());
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("checking");
  const [currency, setCurrency] = useState(props.account?.isoCurrency ?? "USD");
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState(props.account ? "" : "0.00");
  const [direction, setDirection] = useState("out");
  const [category, setCategory] = useState("");
  const [cleared, setCleared] = useState(false);
  const [notes, setNotes] = useState("");
  useEffect(() => {
    let active = true;
    if (!props.tools) {
      setError("Update Moss before adding manual accounts or transactions from this page.");
      return;
    }
    void props.tools
      .invoke("finance.manual.context", {})
      .then((outcome) => {
        if (!active) return;
        if (
          outcome.status !== "succeeded" ||
          outcome.result.status !== "ok" ||
          typeof outcome.result.today !== "string" ||
          !isCalendarDate(outcome.result.today)
        ) {
          setError("Manual entry setup could not load. Close this form and try again.");
          return;
        }
        if (outcome.result.supported !== true) {
          setError("Finance storage needs an update before manual entry is available.");
          return;
        }
        const categories = Array.isArray(outcome.result.categories)
          ? outcome.result.categories.filter(
              (c): c is { id: string; name: string } =>
                c !== null &&
                typeof c === "object" &&
                typeof c.id === "string" &&
                typeof c.name === "string"
            )
          : [];
        setContext({ today: outcome.result.today, supported: true, categories });
        setDate(outcome.result.today);
      })
      .catch(() => {
        if (active) setError("Manual entry setup could not load. Close this form and try again.");
      });
    return () => {
      active = false;
    };
  }, [props.tools]);
  const cents = parseLedgerAmount(amount);
  const entry = Boolean(props.account);
  const debt = entry
    ? ["credit", "loan"].includes(props.account!.type)
    : ["credit", "loan"].includes(kind);
  const disabled = !context || busy || uncertain;
  const valid = Boolean(
    context &&
    name.trim() &&
    isCalendarDate(date) &&
    date <= context.today &&
    (!props.account?.openingDate || date >= props.account.openingDate) &&
    cents !== null &&
    (!entry || cents > 0)
  );
  const save = async () => {
    if (!valid || busy || uncertain || !props.tools || cents === null) return;
    const input = entry
      ? {
          operationId,
          accountId: props.account!.accountId,
          name: name.trim(),
          date,
          amountCents: direction === "out" ? cents : -cents,
          isoCurrency: currency,
          categoryId: category,
          notes,
          cleared
        }
      : {
          operationId,
          name: name.trim(),
          accountType: kind,
          isoCurrency: currency,
          openingDate: date,
          openingBalanceCents: cents
        };
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.tools.invoke(
        entry ? "finance.manual.entry-create" : "finance.manual.account-create",
        input
      );
      const message = manualSaveMessage(outcome);
      if (message === null) {
        props.onSaved();
        return;
      }
      setError(message);
      setUncertain(
        outcome.status === "failed" ||
          outcome.status === "succeeded" ||
          (outcome.status === "rejected" && outcome.moduleCode === "manual_conflict")
      );
    } catch {
      setError("Saving could not be confirmed. Check saved records before starting another entry.");
      setUncertain(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={entry ? "Add transaction" : "Add manual account"}
      description={entry ? props.account!.name : undefined}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          {uncertain ? (
            <Button
              onClick={() => {
                invalidateQueries();
                props.onClose();
              }}
            >
              Check saved records
            </Button>
          ) : (
            <Button variant="primary" disabled={!valid || busy} onClick={() => void save()}>
              {busy ? "Saving…" : entry ? "Save transaction" : "Add account"}
            </Button>
          )}
        </>
      }
    >
      {!context && !error ? <p role="status">Loading your account settings…</p> : null}
      <form
        className="fnm-manual-form"
        onSubmit={(event: { preventDefault: () => void }) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="fnm-block fnm-block--tight">
          {entry ? "Payee" : "Account name"}
          <input
            className="jds-input"
            aria-label={entry ? "Payee" : "Account name"}
            disabled={disabled}
            value={name}
            maxLength={entry ? 160 : 80}
            autoComplete="off"
            onChange={(e: { target: { value: string } }) => setName(e.target.value)}
          />
        </label>
        {!entry ? (
          <div className="fnm-manual-columns">
            <label className="fnm-block fnm-block--tight">
              Account type
              <Select
                aria-label="Account type"
                value={kind}
                disabled={disabled}
                onChange={(e: { target: { value: string } }) => setKind(e.target.value)}
              >
                {MANUAL_ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="fnm-block fnm-block--tight">
              Currency
              <Select
                aria-label="Account currency"
                value={currency}
                disabled={disabled}
                onChange={(e: { target: { value: string } }) => setCurrency(e.target.value)}
              >
                {MANUAL_CURRENCIES.map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </Select>
            </label>
          </div>
        ) : null}
        <div className="fnm-manual-columns">
          <label className="fnm-block fnm-block--tight">
            {entry ? "Date" : "Opening balance date"}
            <input
              className="jds-input"
              aria-label={entry ? "Transaction date" : "Opening balance date"}
              type="date"
              value={date}
              min={props.account?.openingDate}
              max={context?.today}
              disabled={disabled}
              onChange={(e: { target: { value: string } }) => setDate(e.target.value)}
            />
          </label>
          <label className="fnm-block fnm-block--tight">
            {entry
              ? `Amount (${currency})`
              : `${debt ? "Amount owed" : "Opening balance"} (${currency})`}
            <input
              className="jds-input"
              aria-label={entry ? "Transaction amount" : "Opening balance"}
              inputMode="decimal"
              value={amount}
              disabled={disabled}
              onChange={(e: { target: { value: string } }) => setAmount(e.target.value)}
            />
          </label>
        </div>
        {entry ? (
          <>
            <div className="fnm-manual-columns">
              <label className="fnm-block fnm-block--tight">
                Direction
                <Select
                  aria-label="Transaction direction"
                  value={direction}
                  disabled={disabled}
                  onChange={(e: { target: { value: string } }) => setDirection(e.target.value)}
                >
                  <option value="out">Money out</option>
                  <option value="in">Money in / refund</option>
                </Select>
              </label>
              <label className="fnm-block fnm-block--tight">
                Category
                <Select
                  aria-label="Transaction category"
                  value={category}
                  disabled={disabled}
                  onChange={(e: { target: { value: string } }) => setCategory(e.target.value)}
                >
                  <option value="">Uncategorized</option>
                  {context?.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <label className="fnm-block fnm-block--tight">
              Private note
              <textarea
                className="jds-input"
                aria-label="Private note"
                value={notes}
                maxLength={1000}
                disabled={disabled}
                onChange={(e: { target: { value: string } }) => setNotes(e.target.value)}
              />
            </label>
            <Switch
              ariaLabel="Cleared on your statement"
              label="Cleared on your statement"
              checked={cleared}
              disabled={disabled}
              onChange={setCleared}
            />
          </>
        ) : null}
        {cents === null ? (
          <p className="jds-hint">Use a decimal point and no more than two decimal places.</p>
        ) : entry && cents <= 0 ? (
          <p className="jds-hint">
            Enter an amount above zero. For a refund, set Direction to Money in / refund.
          </p>
        ) : (
          <p className="jds-caption">
            {entry ? "Entry" : "Opening balance"}:{" "}
            {formatCents(entry && direction === "in" ? -cents : cents, currency)}
          </p>
        )}
        {error ? (
          <p role="alert" className="jds-hint">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
