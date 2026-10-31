import {
  Button,
  Dialog,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { BillsView, Occurrence } from "./screens/upcoming";
import { centsToAmountInput, dayYearLabel, formatCents, parseAmountToCents } from "./format";
import { isCalendarDate } from "../domain/values";
import { invalidateQueries } from "./store";
export function BillAdjustmentDialog(props: {
  data: BillsView;
  occurrence: Occurrence;
  reset: boolean;
  tools?: ExternalModuleToolsHandleV1;
  returnFocusRef?: { current: HTMLElement | null };
  onClose: () => void;
  onUncertain: () => void;
}): ReactNodeLike {
  const [original] = useState(props.occurrence),
    [data] = useState(props.data),
    [tools] = useState(props.tools),
    [reset] = useState(props.reset);
  const plan = data.plans.find((p) => p.id === original.planId)!;
  const [date, setDate] = useState(original.plannedDate ?? original.dueDate);
  const [amount, setAmount] = useState(centsToAmountInput(original.expectedCents));
  const [captured, setCaptured] = useState<{ plannedDate: string; amountCents: number } | null>(
    reset ? { plannedDate: original.dueDate, amountCents: plan.amountCents } : null
  );
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const cents = parseAmountToCents(amount);
  const valid =
    cents !== null &&
    cents > 0 &&
    isCalendarDate(date) &&
    (date !== (original.plannedDate ?? original.dueDate) || cents !== original.expectedCents);
  const save = async () => {
    if (!tools || !captured || blocked || lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await tools.invoke(
        reset ? "finance.bill.adjust-reset" : "finance.bill.adjust",
        {
          planId: original.planId,
          dueDate: original.dueDate,
          ...(!reset ? captured : {}),
          expectedRevision: data.revision,
          expectedFingerprint: data.fingerprint
        }
      );
      if (!alive.current) return;
      if (result.status === "succeeded" && result.result.status === "ok") {
        invalidateQueries();
        props.onClose();
      } else if (result.status === "cancelled") {
        setMessage("Cancelled. Your captured bill change is kept.");
      } else {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          "The review changed or saving could not be confirmed. Your entries are kept. Close this review and check saved bills before trying again."
        );
      }
    } catch {
      if (alive.current) {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          "Saving could not be confirmed. Close this review and check saved bills before trying again."
        );
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const close = () => {
    if (!lock.current) props.onClose();
  };
  return (
    <Dialog
      title={
        reset
          ? "Reset one-off bill change"
          : captured
            ? "Review bill change"
            : "Change this occurrence"
      }
      scrollBody
      closeLabel="Close"
      closeDisabled={busy}
      returnFocusRef={props.returnFocusRef}
      onClose={close}
      description={`${original.name} · originally ${dayYearLabel(original.dueDate, "short")}`}
      footer={
        <div className="fnm-spread">
          <Button variant="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {captured ? (
            <Button disabled={busy || blocked || !tools} onClick={() => void save()}>
              {busy ? "Saving…" : reset ? "Confirm reset" : "Confirm bill change"}
            </Button>
          ) : (
            <Button
              disabled={!valid || busy || !tools}
              onClick={() => {
                if (valid) setCaptured({ plannedDate: date, amountCents: cents! });
              }}
            >
              Review bill change
            </Button>
          )}
        </div>
      }
    >
      <div className="fnm-block fnm-block--tight">
        <p>
          Current projection: {dayYearLabel(original.plannedDate ?? original.dueDate, "short")} ·{" "}
          {formatCents(original.expectedCents, data.isoCurrency)}
        </p>
        {captured ? (
          <>
            <p>
              <strong>
                {reset ? "Return to plan" : "Proposed projection"}:{" "}
                {dayYearLabel(captured.plannedDate, "short")} ·{" "}
                {formatCents(captured.amountCents, data.isoCurrency)}
              </strong>
            </p>
            {!reset ? (
              <Button
                variant="secondary"
                disabled={busy || blocked}
                onClick={() => {
                  setCaptured(null);
                  setMessage(null);
                }}
              >
                Edit change
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <label className="fnm-block fnm-block--tight">
              Planned date
              <input
                className="jds-input"
                type="date"
                aria-label="Occurrence planned date"
                value={date}
                disabled={busy}
                onChange={(e: { currentTarget: { value: string } }) =>
                  setDate(e.currentTarget.value)
                }
              />
            </label>
            <label className="fnm-block fnm-block--tight">
              Expected amount ({data.isoCurrency})
              <input
                className="jds-input"
                inputMode="decimal"
                aria-label="Occurrence expected amount"
                value={amount}
                disabled={busy}
                onChange={(e: { currentTarget: { value: string } }) =>
                  setAmount(e.currentTarget.value)
                }
              />
            </label>
            {amount.trim() !== "" && (cents === null || cents <= 0) ? (
              <p className="jds-hint" role="status">
                Enter an amount above zero with at most two decimal places.
              </p>
            ) : null}
          </>
        )}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </Dialog>
  );
}
