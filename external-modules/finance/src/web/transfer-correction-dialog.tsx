import {
  Button,
  Checkbox,
  Dialog,
  randomUuid,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { TransferReview } from "../domain/transfer-corrections";
import type { TransferAccount } from "../domain/manual-transfers";
import { isCalendarDate } from "../domain/values";
import { invokeTool } from "./api";
import { dayYearLabel, formatCents } from "./format";
import { transferBalance } from "./manual-transfer";
import { useReadCooldown } from "./read-cooldown";
interface Context extends Record<string, unknown> {
  status: string;
  supported: boolean;
  today: string;
  receipt: TransferReview | null;
  accounts: TransferAccount[];
}
const statementThrough = (account?: TransferAccount): string =>
  account?.lastReconciledDate ? dayYearLabel(account.lastReconciledDate, "short") : "none";
interface Captured {
  receipt: TransferReview;
  from: TransferAccount;
  to: TransferAccount;
  date: string;
  cleared: boolean;
  fromAfter: number;
  toAfter: number;
}
export function TransferCorrectionDialog(props: {
  transferId: string;
  tools: ExternalModuleToolsHandleV1;
  onClose: () => void;
  onSaved: () => void;
  onReview: (id: string) => void;
  /** Where focus lands when the review closes; defaults to the control that opened it. */
  returnFocusRef?: { readonly current: HTMLElement | null };
}): ReactNodeLike {
  const [context, setContext] = useState<Context | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState<string | null>(null),
    [date, setDate] = useState(""),
    [cleared, setCleared] = useState(false),
    [captured, setCaptured] = useState<Captured | null>(null),
    [operationId] = useState(() => randomUuid());
  const pending = useRef(false),
    generation = useRef(0),
    cooldown = useReadCooldown();
  const close = () => {
    if (!pending.current) props.onClose();
  };
  const read = async () => {
    if (pending.current || cooldown.cooling) return;
    const token = ++generation.current;
    setLoading(true);
    setMessage(null);
    const result = await invokeTool<Context>("finance.manual.transfer-review", {
      originalTransferId: props.transferId
    });
    if (token !== generation.current) return;
    setLoading(false);
    if (result.kind === "ok" && result.result.status === "ok" && result.result.supported) {
      setContext(result.result);
      setDate((old) => old || result.result.today);
      setCaptured(null);
      setBlocked(false);
    } else {
      setBlocked(true);
      if (result.kind === "error" && result.retryAfterSeconds)
        cooldown.wait(result.retryAfterSeconds);
      setMessage(
        result.kind === "error"
          ? result.message
          : "Update Finance or check your access before reviewing this recording."
      );
    }
  };
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
    };
  }, []);
  const receipt = context?.receipt,
    from = context?.accounts.find((a) => a.accountId === receipt?.toAccountId),
    to = context?.accounts.find((a) => a.accountId === receipt?.fromAccountId);
  const unavailable = !receipt
    ? "This owned manual transfer could not be found."
    : !receipt.intact
      ? "The original entries need repair before a correction can be recorded. Check their saved history."
      : receipt.correctedBy
        ? null
        : !from || !to
          ? "Both ledgers must be open manual cash or card accounts before recording a correction."
          : from.isoCurrency !== receipt.isoCurrency || to.isoCurrency !== receipt.isoCurrency
            ? "Both saved ledgers must use the original currency."
            : null;
  const dateIssue =
    context &&
    receipt &&
    from &&
    to &&
    (!isCalendarDate(date) ||
      date > context.today ||
      date < receipt.date ||
      date < from.openingDate ||
      date < to.openingDate ||
      (from.lastReconciledDate && date <= from.lastReconciledDate) ||
      (to.lastReconciledDate && date <= to.lastReconciledDate))
      ? "Choose a date on or after the original and both opening dates, after both completed statements, and no later than today."
      : null;
  const editable = !loading && !busy && !blocked;
  const canReverse =
    editable && receipt && !receipt.correctedBy && !unavailable && !dateIssue && from && to;
  const review = () => {
    if (!canReverse || pending.current) return;
    try {
      setCaptured({
        receipt,
        from,
        to,
        date,
        cleared,
        fromAfter: transferBalance(from, receipt.amountCents),
        toAfter: transferBalance(to, -receipt.amountCents)
      });
      setMessage(null);
    } catch {
      setMessage(
        "The resulting balances exceed the supported exact-money range. No correction was recorded."
      );
    }
  };
  const save = async () => {
    if (!captured || pending.current || blocked || loading) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools.invoke("finance.manual.transfer-reverse", {
        operationId,
        originalTransferId: captured.receipt.transferId,
        sourceRevision: captured.receipt.sourceRevision,
        fromRevision: captured.from.revision,
        toRevision: captured.to.revision,
        date: captured.date,
        cleared: captured.cleared
      });
      if (result.status === "succeeded" && result.result.status === "ok") {
        props.onSaved();
        return;
      }
      if (result.status === "cancelled")
        setMessage("Cancelled. Your captured correction is kept; no new entries were recorded.");
      else {
        setBlocked(true);
        setMessage(
          result.status === "rejected" && result.moduleCode === "transfer_changed"
            ? "The saved recording or ledgers changed. No correction was recorded. Check the saved transfer before reviewing again."
            : "Saving could not be confirmed. Check the saved transfer and account history before trying again."
        );
      }
    } catch {
      setBlocked(true);
      setMessage(
        "Saving could not be confirmed. Check the saved transfer and account history before trying again."
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const follow = (id: string) => {
    if (!pending.current) props.onReview(id);
  };
  return (
    <Dialog
      title="Review manual transfer"
      scrollBody
      closeDisabled={busy}
      closeLabel="Close transfer review"
      returnFocusRef={props.returnFocusRef}
      dismissOnEscape={!busy}
      dismissOnBackdrop={!busy}
      onClose={close}
      footer={
        <>
          {captured ? (
            <>
              <Button
                variant="secondary"
                disabled={!editable}
                onClick={() => {
                  if (!pending.current) setCaptured(null);
                }}
              >
                Back
              </Button>
              <Button disabled={!editable} onClick={() => void save()}>
                {busy ? "Recording correction…" : "Confirm correction"}
              </Button>
            </>
          ) : receipt && !receipt.correctedBy ? (
            <Button disabled={!canReverse} onClick={review}>
              Review correction
            </Button>
          ) : null}
          {!captured ? (
            <Button variant="secondary" disabled={busy} onClick={close}>
              Close
            </Button>
          ) : null}
        </>
      }
    >
      <div className="fnm-block fnm-block--tight fnm-account-management">
        {loading ? <p role="status">Reading saved transfer and ledgers…</p> : null}
        {message ? <p role="status">{message}</p> : null}
        {blocked ? (
          <Button
            variant="secondary"
            disabled={loading || busy || cooldown.cooling}
            onClick={() => void read()}
          >
            Check saved transfer
          </Button>
        ) : null}
        {receipt ? (
          <>
            <p>
              <strong>
                {formatCents(receipt.amountCents, receipt.isoCurrency)} {receipt.isoCurrency}
              </strong>{" "}
              · Original date {dayYearLabel(receipt.date, "short")}
            </p>
            <p>
              From <strong>{receipt.fromName}</strong> to <strong>{receipt.toName}</strong>.
            </p>
            {receipt.correctsTransferId ? (
              <Button
                variant="link"
                disabled={busy}
                onClick={() => follow(receipt.correctsTransferId!)}
              >
                View original recording
              </Button>
            ) : null}
            {receipt.correctedBy ? (
              <>
                <p role="status">
                  Correction recorded on {dayYearLabel(receipt.correctedBy.date, "short")}. The
                  original cannot be corrected twice.
                </p>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => follow(receipt.correctedBy!.transferId)}
                >
                  View correction
                </Button>
              </>
            ) : null}
          </>
        ) : !loading && context ? (
          <p role="status">{unavailable}</p>
        ) : null}
        {receipt && !receipt.correctedBy && unavailable ? <p role="status">{unavailable}</p> : null}
        {captured ? (
          <>
            <p>
              <strong>New correction · {dayYearLabel(captured.date, "short")}</strong> ·{" "}
              {captured.cleared ? "Both entries cleared" : "Not yet cleared"}
            </p>
            <p>
              From <strong>{captured.from.name}</strong>:{" "}
              {formatCents(captured.from.balanceCents, captured.receipt.isoCurrency)} →{" "}
              {formatCents(captured.fromAfter, captured.receipt.isoCurrency)}
              {captured.from.type === "credit" ? " owed" : ""}.
            </p>
            <p>
              To <strong>{captured.to.name}</strong>:{" "}
              {formatCents(captured.to.balanceCents, captured.receipt.isoCurrency)} →{" "}
              {formatCents(captured.toAfter, captured.receipt.isoCurrency)}
              {captured.to.type === "credit" ? " owed" : ""}.
            </p>
          </>
        ) : receipt && !receipt.correctedBy && !unavailable ? (
          <>
            <label className="fnm-block fnm-block--tight">
              Correction date
              <input
                className="jds-input"
                aria-label="Correction date"
                type="date"
                min={receipt.date}
                max={context?.today}
                value={date}
                disabled={!editable}
                onChange={(e) => setDate(e.currentTarget.value)}
              />
            </label>
            {dateIssue ? <p role="status">{dateIssue}</p> : null}
            <p className="jds-hint">
              {from?.name}: statement through {statementThrough(from)}. {to?.name}: statement
              through {statementThrough(to)}.
            </p>
            <label className="fnm-inline">
              <Checkbox
                ariaLabel="Both correction entries are cleared"
                checked={cleared}
                disabled={!editable}
                onChange={() => setCleared(!cleared)}
              />
              Both new entries are cleared
            </label>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
