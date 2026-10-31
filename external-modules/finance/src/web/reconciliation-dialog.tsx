import {
  Button,
  Dialog,
  RowIndex,
  RowIndexItem,
  Switch,
  randomUuid,
  useEffect,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import {
  MAX_RECONCILE_ENTRIES,
  reconciledSelectionBalance,
  type ReconciliationView
} from "../domain/reconciliation";
import { isCalendarDate } from "../domain/values";
import { dayYearLabel, formatCents } from "./format";
import { parseLedgerAmount, type ManualAccountChoice } from "./manual-entry";

/** Quiet time after the last edit to the statement date before a new read starts. */
const STATEMENT_DATE_PAUSE_MS = 600;

/** A statement date worth reading: a real day between the account's opening and today. */
function canReadStatement(date: string, today: string, openingDate: string): boolean {
  return isCalendarDate(date) && date <= today && date >= openingDate;
}

export function ReconciliationDialog(props: {
  account: ManualAccountChoice;
  tools?: ExternalModuleToolsHandleV1;
  returnFocusRef?: { current: HTMLElement | null };
  onClose: () => void;
  onSaved: () => void;
}): ReactNodeLike {
  const [operationId] = useState(() => randomUuid());
  const [view, setView] = useState<ReconciliationView | null>(null);
  const [requestedDate, setRequestedDate] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [loadedDate, setLoadedDate] = useState("");
  const [today, setToday] = useState("");
  const [balance, setBalance] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    if (!props.tools) {
      setError("Update Moss before reconciling statements from this page.");
      setLoading(false);
      return;
    }
    void props.tools
      .invoke("finance.reconciliation.read", {
        accountId: props.account.accountId,
        ...(requestedDate ? { statementDate: requestedDate } : {})
      })
      .then((outcome) => {
        if (!active) return;
        if (
          outcome.status !== "succeeded" ||
          outcome.result.status !== "ok" ||
          !outcome.result.view ||
          typeof outcome.result.statementDate !== "string" ||
          typeof outcome.result.today !== "string"
        ) {
          setView(null);
          setError("The statement review could not load. Close it and try again.");
          return;
        }
        const next = outcome.result.view as unknown as ReconciliationView;
        const readDate = outcome.result.statementDate;
        setView(next);
        setStale(false);
        setLoadedDate(readDate);
        setStatementDate((typed) => (typed === "" || typed === requestedDate ? readDate : typed));
        setToday(outcome.result.today);
        setSelected(
          new Set(next.entries.filter((entry) => entry.cleared).map((entry) => entry.id))
        );
      })
      .catch(() => {
        if (active) {
          setView(null);
          setError("The statement review could not load. Close it and try again.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.tools, props.account.accountId, requestedDate, refresh]);
  useEffect(() => {
    if (!view || statementDate === loadedDate) return;
    if (!canReadStatement(statementDate, today, view.openingDate)) return;
    const timer = setTimeout(() => setRequestedDate(statementDate), STATEMENT_DATE_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [view, statementDate, loadedDate, today]);
  const amount = parseLedgerAmount(balance);
  const tooMany = Boolean(view && view.totalEntries > MAX_RECONCILE_ENTRIES);
  const cleared = view && !tooMany ? reconciledSelectionBalance(view, selected) : null;
  const difference = amount === null || cleared === null ? null : BigInt(amount) - BigInt(cleared);
  const dateValid = Boolean(
    view &&
    isCalendarDate(statementDate) &&
    statementDate <= today &&
    statementDate >= view.openingDate &&
    (!view.lastReconciledDate || statementDate > view.lastReconciledDate)
  );
  const canFinish =
    !loading &&
    !busy &&
    !uncertain &&
    !stale &&
    !tooMany &&
    dateValid &&
    statementDate === loadedDate &&
    difference === 0n;
  const locked = busy || uncertain;
  const disabled = loading || locked;
  const save = async () => {
    if (!canFinish || !view || amount === null || !props.tools) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.tools.invoke("finance.reconciliation.finish", {
        operationId,
        accountId: props.account.accountId,
        statementDate,
        balanceCents: amount,
        isoCurrency: view.isoCurrency,
        expectedRevision: view.revision,
        selectedIds: [...selected].sort()
      });
      if (outcome.status === "succeeded" && outcome.result.status === "ok") {
        props.onSaved();
      } else if (outcome.status === "rejected" && outcome.moduleCode === "stale_reconciliation") {
        setStale(true);
        setError(
          "The ledger changed or this statement no longer matches. Your entries are kept. Refresh the review before finishing."
        );
      } else if (outcome.status === "cancelled") {
        setError("Cancelled. Your statement entries are kept.");
      } else if (outcome.status === "invalid_input" || outcome.status === "rejected") {
        setError("Check the statement date, balance and selected entries. Nothing was reconciled.");
      } else {
        setUncertain(true);
        setError(
          "Reconciliation could not be confirmed. Close and check the last reconciled statement before trying again."
        );
      }
    } catch {
      setUncertain(true);
      setError(
        "Reconciliation could not be confirmed. Close and check the last reconciled statement before trying again."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Reconcile a statement"
      description={props.account.name}
      returnFocusRef={props.returnFocusRef}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!canFinish} onClick={() => void save()}>
            {busy ? "Finishing…" : "Finish reconciliation"}
          </Button>
        </>
      }
    >
      <div className="fnm-manual-form">
        {loading && !view ? <p role="status">Loading statement entries…</p> : null}
        {view ? (
          <>
            <div className="fnm-manual-columns">
              <label className="fnm-block fnm-block--tight">
                Statement date
                <input
                  className="jds-input"
                  aria-label="Statement date"
                  type="date"
                  value={statementDate}
                  min={view.openingDate}
                  max={today}
                  disabled={locked}
                  onChange={(e: { target: { value: string } }) => setStatementDate(e.target.value)}
                  onBlur={() => {
                    if (
                      statementDate !== loadedDate &&
                      canReadStatement(statementDate, today, view.openingDate)
                    )
                      setRequestedDate(statementDate);
                  }}
                />
              </label>
              <label className="fnm-block fnm-block--tight">
                {view.debt ? "Amount owed on statement" : "Statement balance"} ({view.isoCurrency})
                <input
                  className="jds-input"
                  inputMode="decimal"
                  value={balance}
                  disabled={locked}
                  onChange={(e: { target: { value: string } }) => setBalance(e.target.value)}
                />
              </label>
            </div>
            {/* Below the fields, so a read never moves the date being typed. */}
            {loading ? <p role="status">Loading statement entries…</p> : null}
            <p className="jds-caption">
              {view.lastReconciledDate
                ? `Last reconciled statement: ${dayYearLabel(view.lastReconciledDate, "short")}.`
                : `Opening baseline: ${dayYearLabel(view.openingDate, "short")}.`}
            </p>
            <RowIndex density="compact">
              <RowIndexItem
                title="Recorded balance on statement date"
                meta={formatCents(view.recordedCents, view.isoCurrency)}
              />
              <RowIndexItem
                title="Cleared balance selected below"
                meta={cleared === null ? "Unavailable" : formatCents(cleared, view.isoCurrency)}
              />
              <RowIndexItem
                title="Difference"
                meta={
                  difference === null
                    ? "Enter a statement balance"
                    : difference > 9007199254740991n || difference < -9007199254740991n
                      ? "Beyond supported precision"
                      : formatCents(Number(difference), view.isoCurrency)
                }
              />
            </RowIndex>
            {!dateValid ? (
              <p role="status" className="jds-hint">
                Choose a date on or after opening, after the last reconciled statement, and no later
                than today.
              </p>
            ) : null}
            {tooMany ? (
              <p role="status" className="jds-hint">
                There are {view.totalEntries} unreconciled entries. Choose an earlier statement date
                to review at most {MAX_RECONCILE_ENTRIES} at a time. Finishing is unavailable while
                the list is incomplete.
              </p>
            ) : null}
            {difference !== null && difference !== 0n ? (
              <p role="status" className="jds-hint">
                The balances do not match yet. Check the statement amount and which entries have
                cleared.
              </p>
            ) : null}
            <p className="jds-caption">
              {view.entries.length} unreconciled entries through {dayYearLabel(loadedDate, "short")}
              .
            </p>
            <RowIndex density="compact">
              {view.entries.map((entry) => (
                <RowIndexItem
                  key={entry.id}
                  title={entry.name}
                  excerpt={`${dayYearLabel(entry.date, "short")} · ${entry.amountCents > 0 ? "Money out" : "Money in"} · ${formatCents(Math.abs(entry.amountCents), view.isoCurrency)}`}
                  meta={
                    <Switch
                      ariaLabel={`Cleared: ${entry.name} on ${dayYearLabel(entry.date, "short")}`}
                      checked={selected.has(entry.id)}
                      disabled={disabled || tooMany}
                      onChange={(checked) =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        })
                      }
                    />
                  }
                />
              ))}
            </RowIndex>
          </>
        ) : null}
        {error ? (
          <p className="jds-hint" role="alert">
            {error}
          </p>
        ) : null}
        {error && !uncertain && props.tools ? (
          <Button
            variant="link"
            disabled={busy || loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh statement review
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
