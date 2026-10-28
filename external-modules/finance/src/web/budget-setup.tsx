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

function recordedAmount(cents: string): string {
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${(absolute / 100n).toLocaleString()}.${String(absolute % 100n).padStart(2, "0")}`;
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
      <SectionHead title="Give your budget a currency" rule />
      <Note variant="practical">
        One budget, one currency. Checking, savings, cash and credit cards in this currency fund
        your plan. Other currencies and tracking accounts stay visible in Accounts and Reports.
      </Note>
      <p className="jds-hint">
        Your choice stays fixed. Moss does not convert balances or change transaction amounts.
      </p>
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
          <p className="jds-hint">
            The same amounts, with no conversion. After setup they will be read as{" "}
            {currency || "your chosen currency"}.
          </p>
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
