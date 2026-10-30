import { useReadCooldown } from "./read-cooldown";
import {
  Button,
  Checkbox,
  Dialog,
  Note,
  Select,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { TransferAccount } from "../domain/manual-transfers";
import { safeCents } from "../domain/values";
import { invokeTool } from "./api";
import { formatCents } from "./format";
import { parseLedgerAmount } from "./manual-entry";
import { announce } from "./states";
export function transferBalance(account: TransferAccount, movement: number): number {
  return safeCents(
    (
      BigInt(account.balanceCents) +
      (account.type === "credit" ? 1n : -1n) * BigInt(movement)
    ).toString()
  );
}
interface Context extends Record<string, unknown> {
  status: string;
  supported: boolean;
  today: string;
  accounts: TransferAccount[];
}
interface Captured {
  from: TransferAccount;
  to: TransferAccount;
  amountCents: number;
  date: string;
  cleared: boolean;
  fromAfter: number;
  toAfter: number;
}
export function ManualTransferDialog(props: {
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
  onSaved: () => void;
}): ReactNodeLike {
  const [context, setContext] = useState<Context | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const [fromId, setFromId] = useState(""),
    [toId, setToId] = useState(""),
    [amount, setAmount] = useState(""),
    [date, setDate] = useState(""),
    [cleared, setCleared] = useState(false),
    [captured, setCaptured] = useState<Captured | null>(null);
  const cooldown = useReadCooldown();
  const [operationId] = useState(() => crypto.randomUUID()),
    generation = useRef(0),
    pending = useRef(false);
  const read = async () => {
    const token = ++generation.current;
    setLoading(true);
    setMessage(null);
    const outcome = await invokeTool<Context>("finance.manual.transfer-context", {});
    if (token !== generation.current) return;
    setLoading(false);
    if (outcome.kind === "ok" && outcome.result.status === "ok" && outcome.result.supported) {
      setContext(outcome.result);
      setDate((old) => old || outcome.result.today);
      setBlocked(false);
      setCaptured(null);
    } else {
      setBlocked(true);
      if (outcome.kind === "error" && outcome.retryAfterSeconds)
        cooldown.wait(outcome.retryAfterSeconds);
      setMessage(
        outcome.kind === "error" && outcome.retryAfterSeconds
          ? outcome.message
          : outcome.kind === "ok" && !outcome.result.supported
            ? "Update Finance storage before recording linked transfers."
            : "Saved ledgers could not be read. Your inputs are kept. Check your connection and review again."
      );
    }
  };
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
    };
  }, []);
  const from = context?.accounts.find((a) => a.accountId === fromId),
    to = context?.accounts.find((a) => a.accountId === toId);
  const review = () => {
    try {
      const amountCents = parseLedgerAmount(amount);
      if (
        !from ||
        !to ||
        from.accountId === to.accountId ||
        from.isoCurrency !== to.isoCurrency ||
        amountCents === null ||
        amountCents <= 0
      )
        throw new Error("Choose two different ledgers in the same currency and a positive amount.");
      if (
        !date ||
        date > context!.today ||
        date < from.openingDate ||
        date < to.openingDate ||
        (from.lastReconciledDate && date <= from.lastReconciledDate) ||
        (to.lastReconciledDate && date <= to.lastReconciledDate)
      )
        throw new Error(
          "Choose a recorded date after both statements, on or after both opening dates, and no later than today."
        );
      setCaptured({
        from,
        to,
        amountCents,
        date,
        cleared,
        fromAfter: transferBalance(from, amountCents),
        toAfter: transferBalance(to, -amountCents)
      });
      setMessage(null);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Check the exact amount and both ledgers."
      );
    }
  };
  const save = async () => {
    if (!captured || !props.tools || pending.current || blocked || loading) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools.invoke("finance.manual.transfer-create", {
        operationId,
        fromAccountId: captured.from.accountId,
        toAccountId: captured.to.accountId,
        fromRevision: captured.from.revision,
        toRevision: captured.to.revision,
        date: captured.date,
        amountCents: captured.amountCents,
        isoCurrency: captured.from.isoCurrency,
        cleared: captured.cleared
      });
      if (result.status === "succeeded" && result.result.status === "ok") {
        announce("Linked transfer recorded. Both ledger balances are saved.");
        props.onSaved();
        return;
      }
      if (result.status === "cancelled")
        setMessage("Cancelled. Your captured transfer is kept; no new movement was recorded.");
      else {
        setBlocked(true);
        setMessage(
          result.status === "rejected" && result.moduleCode === "transfer_changed"
            ? "One of these ledgers changed or no longer accepts this date. No transfer was recorded. Review both saved accounts before trying again."
            : "Saving could not be confirmed. Keep this draft and check account history before starting another transfer. Review saved accounts before retrying this operation."
        );
      }
    } catch {
      setBlocked(true);
      setMessage(
        "Saving could not be confirmed. Keep this draft and check account history before starting another transfer. Review saved accounts before retrying this operation."
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const editable = !busy && !loading && !blocked;
  return (
    <Dialog
      title="Record a manual transfer"
      description="Link a past movement between your own ledgers"
      scrollBody
      closeDisabled={busy}
      dismissOnEscape={!busy}
      dismissOnBackdrop={!busy}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      footer={
        <>
          {captured ? (
            <>
              <Button
                variant="secondary"
                disabled={busy || blocked}
                onClick={() => setCaptured(null)}
              >
                Edit transfer
              </Button>
              <Button disabled={!editable || !props.tools} onClick={() => void save()}>
                {busy ? "Recording transfer…" : "Record linked transfer"}
              </Button>
            </>
          ) : (
            <Button
              disabled={
                !editable ||
                !context ||
                context.accounts.length < 2 ||
                !from ||
                !to ||
                !amount ||
                !date ||
                !props.tools
              }
              onClick={review}
            >
              Review transfer
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="fnm-block fnm-block--tight fnm-account-management">
        <Note variant="practical">
          This records money already moved. Moss sends no money or bank instructions. Only
          same-currency manual cash accounts and cards are supported; loans, investments, banks and
          shared ledgers stay separate.
        </Note>
        {loading ? <p role="status">Reading saved ledgers…</p> : null}
        {message ? <p role="status">{message}</p> : null}
        {blocked ? (
          <Button
            variant="secondary"
            disabled={loading || busy || cooldown.cooling}
            onClick={() => void read()}
          >
            Review saved accounts
          </Button>
        ) : null}
        {context && context.accounts.length < 2 ? (
          <p>
            Add two manual cash or card ledgers in the same currency in Accounts before recording a
            transfer.
          </p>
        ) : null}
        {captured ? (
          <>
            <p>
              <strong>
                {formatCents(captured.amountCents, captured.from.isoCurrency)}{" "}
                {captured.from.isoCurrency}
              </strong>{" "}
              · {captured.date} · {captured.cleared ? "Cleared" : "Not yet cleared"}
            </p>
            <p>
              From <strong>{captured.from.name}</strong>:{" "}
              {formatCents(captured.from.balanceCents, captured.from.isoCurrency)} →{" "}
              {formatCents(captured.fromAfter, captured.from.isoCurrency)}
              {captured.from.type === "credit" ? " owed" : ""}.
            </p>
            <p>
              To <strong>{captured.to.name}</strong>:{" "}
              {formatCents(captured.to.balanceCents, captured.to.isoCurrency)} →{" "}
              {formatCents(captured.toAfter, captured.to.isoCurrency)}
              {captured.to.type === "credit" ? " owed" : ""}.
            </p>
            <p>
              Two linked entries will be saved together. This movement changes neither your total
              net worth nor income and spending. Existing statement periods stay locked.
            </p>
          </>
        ) : context ? (
          <>
            <label className="fnm-block fnm-block--tight">
              From account
              <Select
                aria-label="From account"
                value={fromId}
                disabled={!editable}
                onChange={(event) => {
                  setFromId(event.currentTarget.value);
                  setToId("");
                }}
              >
                <option value="">Choose a source ledger</option>
                {context.accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name} · {a.isoCurrency}
                  </option>
                ))}
              </Select>
            </label>
            <label className="fnm-block fnm-block--tight">
              To account
              <Select
                aria-label="To account"
                value={toId}
                disabled={!editable || !from}
                onChange={(event) => setToId(event.currentTarget.value)}
              >
                <option value="">Choose a destination ledger</option>
                {context.accounts
                  .filter((a) => a.accountId !== fromId && a.isoCurrency === from?.isoCurrency)
                  .map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.name} · {a.isoCurrency}
                    </option>
                  ))}
              </Select>
            </label>
            {from &&
            !context.accounts.some(
              (a) => a.accountId !== fromId && a.isoCurrency === from.isoCurrency
            ) ? (
              <p>
                No other eligible {from.isoCurrency} ledger is available. Add one in Accounts first.
              </p>
            ) : null}
            <div className="fnm-manual-columns">
              <label className="fnm-block fnm-block--tight">
                Transfer amount {from?.isoCurrency ?? ""}
                <input
                  className="jds-input"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  disabled={!editable}
                  onChange={(event) => setAmount(event.currentTarget.value)}
                />
              </label>
              <label className="fnm-block fnm-block--tight">
                Recorded date
                <input
                  className="jds-input"
                  type="date"
                  max={context.today}
                  value={date}
                  disabled={!editable}
                  onChange={(event) => setDate(event.currentTarget.value)}
                />
              </label>
            </div>
            <label className="fnm-inline">
              <Checkbox
                ariaLabel="Both transfer entries are cleared"
                checked={cleared}
                disabled={!editable}
                onChange={() => setCleared(!cleared)}
              />
              Both entries are cleared
            </label>
            <p className="jds-hint">
              Mark cleared only if both ledgers have posted this movement. A card balance is shown
              as the amount owed; paying it lowers that balance.
            </p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
