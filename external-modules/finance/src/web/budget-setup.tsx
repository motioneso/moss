import {
  Button,
  Note,
  SectionHead,
  Select,
  RowIndex,
  RowIndexItem,
  Switch,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { invalidateQueries } from "./store";
import { navigate } from "./router";

/** Exact whole cents of any size in the browser's own digits, grouping and decimal mark. */
export function recordedAmount(cents: string, locale?: string): string {
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  // ECMA-402 reads a decimal string exactly; the TS library types only numbers.
  const formatDecimal = formatter.format as (value: number | string) => string;
  return `${value < 0n ? "−" : ""}${formatDecimal(`${absolute}E-2`)}`;
}

export function BudgetSetup(props: {
  tools?: ExternalModuleToolsHandleV1;
  storageReady: boolean;
  legacyMonthCount: number;
  legacyDraft?: boolean;
  legacyMonths?: { month: string; totalCents: string }[];
  currencies: string[];
  accountCurrencies: string[];
}): ReactNodeLike {
  const needsReview = props.legacyMonthCount > 0 || props.legacyDraft === true;
  const [currency, setCurrency] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const save = async () => {
    if (!props.tools || !currency || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools.invoke("finance.budget.configure", {
        isoCurrency: currency,
        acknowledgeLegacy: acknowledge
      });
      if (result.status === "succeeded" && result.result.status === "ok") invalidateQueries();
      else if (result.status === "cancelled")
        setMessage("Cancelled. Your currency choice is kept for review.");
      else if (result.status === "rejected" && result.moduleCode === "budget_currency_fixed") {
        setMessage(
          "A currency was already selected in another session. Refresh to see the saved budget."
        );
        invalidateQueries();
      } else
        setMessage(
          "The currency choice could not be confirmed. Refresh to check the saved budget before trying again."
        );
    } catch {
      setMessage("The currency choice could not be confirmed. Refresh to check the saved budget.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fnm-block fnm-budget-setup" aria-label="Budget currency setup">
      <p className="jds-hint">You can't change the budget currency later.</p>
      {props.accountCurrencies.length > 0 ? (
        <p>Account currencies: {props.accountCurrencies.join(", ")}</p>
      ) : (
        <Button variant="secondary" onClick={() => navigate("/accounts")}>
          Add an account
        </Button>
      )}
      <label className="fnm-block fnm-block--tight">
        Budget currency
        <Select
          aria-label="Budget currency"
          value={currency}
          disabled={busy || !props.storageReady}
          onChange={(event: { currentTarget: { value: string } }) =>
            setCurrency(event.currentTarget.value)
          }
        >
          <option value="">Choose a currency</option>
          {props.currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
      </label>
      {props.legacyMonthCount > 0 ? (
        <Note variant="pull">
          You have assignments in {props.legacyMonthCount}{" "}
          {props.legacyMonthCount === 1 ? "month" : "months"} from before currency setup. Their
          amounts stay unchanged. Review the recorded totals before choosing.
        </Note>
      ) : null}
      {props.legacyMonths?.length ? (
        <section aria-label="Existing monthly assignments" className="fnm-block fnm-block--tight">
          <SectionHead title="Recorded monthly totals" rule />
          <RowIndex variant="facts">
            {props.legacyMonths.map((row) => (
              <RowIndexItem
                key={row.month}
                title={row.month}
                meta={recordedAmount(row.totalCents)}
              />
            ))}
          </RowIndex>
        </section>
      ) : null}
      {props.legacyDraft ? (
        <Note variant="pull">
          Your open first-budget draft predates currency setup. Choosing a currency closes this
          draft. Build a new draft from the same transactions afterward.
        </Note>
      ) : null}
      {needsReview ? (
        <Switch
          ariaLabel="Acknowledge existing assignments"
          checked={acknowledge}
          disabled={busy}
          onChange={setAcknowledge}
          label={
            props.legacyMonthCount > 0
              ? `Interpret my existing assignment amounts as ${currency || "the chosen currency"}${props.legacyDraft ? " and replace the open draft" : ""}`
              : "Replace my open draft after choosing this currency"
          }
        />
      ) : null}
      {!props.storageReady ? (
        <Note variant="practical">
          Finance storage needs to finish updating before you can choose a budget currency.
        </Note>
      ) : !props.tools ? (
        <Note variant="practical">Update Moss to enable reviewed budget setup.</Note>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="fnm-inline">
        <Button
          disabled={
            !props.tools ||
            !props.storageReady ||
            !currency ||
            busy ||
            (needsReview && !acknowledge)
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Review currency choice"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={invalidateQueries}>
          Refresh
        </Button>
      </div>
    </section>
  );
}
