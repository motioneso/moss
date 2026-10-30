import { targetKindLabel, weeklyPeriodLabel } from "./target-description";
import {
  Button,
  Checkbox,
  Dialog,
  Note,
  RowIndex,
  RowIndexItem,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { selectTargetFunding, type TargetFundingLine } from "../domain/target-funding";
import { formatCents, monthLabel } from "./format";
import { invalidateQueries } from "./store";
export interface TargetFundingView {
  month: string;
  currency: string;
  revision: number;
  fingerprint: string;
  readyCents: number | null;
  lines: TargetFundingLine[];
}
const reason = {
  archived: "Category unavailable",
  pooled: "Fund through the flexible pool",
  reached: "No additional suggestion",
  assignment_limit: "Use a smaller manual assignment within the supported amount limit"
};
export function TargetFundingDialog(props: {
  data: TargetFundingView;
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
  onUncertain: () => void;
  onSaved?: (fingerprint: string) => void;
}): ReactNodeLike {
  const [data] = useState(props.data),
    [tools] = useState(props.tools);
  const [ids, setIds] = useState<string[]>([]);
  const [captured, setCaptured] = useState<{ ids: string[]; amounts: number[] } | null>(null);
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
  const amounts = ids.map((id) => data.lines.find((line) => line.categoryId === id)!.amountCents);
  let selected: ReturnType<typeof selectTargetFunding> | null = null;
  let selectionError: string | null = null;
  try {
    selected = selectTargetFunding(data.lines, ids, amounts, data.readyCents);
  } catch (error) {
    if (ids.length)
      selectionError = error instanceof Error ? error.message : "Check your selection";
  }
  const total = amounts.reduce((sum, n) => sum + BigInt(n), 0n);
  const close = () => {
    if (!lock.current) props.onClose();
  };
  const save = async () => {
    if (!captured || !tools || lock.current || blocked) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await tools.invoke("finance.targets.fund", {
        month: data.month,
        categoryIds: captured.ids,
        expectedAmountsCents: captured.amounts,
        expectedRevision: data.revision,
        expectedFingerprint: data.fingerprint
      });
      if (!alive.current) return;
      if (result.status === "succeeded" && result.result.status === "ok") {
        invalidateQueries();
        props.onSaved?.(data.fingerprint);
        props.onClose();
      } else if (result.status === "cancelled")
        setMessage("Cancelled. Your captured funding selection is kept.");
      else {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          "The budget or target guidance changed, or saving could not be confirmed. Your selection is kept. Close this review and check saved records before trying again."
        );
      }
    } catch {
      if (alive.current) {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          "Saving could not be confirmed. Close this review and check saved records before trying again."
        );
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Dialog
      title={captured ? "Review target assignments" : "Choose target funding"}
      description={`${monthLabel(data.month)} · ${data.currency}`}
      scrollBody
      closeLabel="Close"
      closeDisabled={busy}
      onClose={close}
      footer={
        <div className="fnm-spread">
          <Button variant="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {captured ? (
            <Button disabled={busy || blocked || !tools} onClick={() => void save()}>
              {busy ? "Saving…" : "Confirm target assignments"}
            </Button>
          ) : (
            <Button
              disabled={!selected || busy || !tools}
              onClick={() => {
                if (selected) setCaptured({ ids: [...ids], amounts: [...amounts] });
              }}
            >
              Review selected amounts
            </Button>
          )}
        </div>
      }
    >
      <div className="fnm-block fnm-block--tight">
        <Note variant="practical">
          Assign ready-to-assign money to selected categories. This changes your plan; no bank money
          moves and no transaction is created.
        </Note>
        <p>
          <strong>
            Ready to assign:{" "}
            {data.readyCents === null ? "Unavailable" : formatCents(data.readyCents, data.currency)}
          </strong>
        </p>
        {captured ? (
          <>
            <RowIndex variant="facts">
              {selected?.assignments.map((a) => (
                <RowIndexItem
                  key={a.categoryId}
                  title={data.lines.find((line) => line.categoryId === a.categoryId)!.name}
                  meta={`${formatCents(a.previousCents, data.currency)} → ${formatCents(a.amountCents, data.currency)}`}
                />
              ))}
            </RowIndex>
            <p>
              <strong>
                Add {selected ? formatCents(selected.totalCents, data.currency) : "—"} · Ready
                afterward {selected ? formatCents(selected.readyAfterCents, data.currency) : "—"}
              </strong>
            </p>
            <Button
              variant="secondary"
              disabled={busy || blocked}
              onClick={() => {
                setCaptured(null);
                setMessage(null);
              }}
            >
              Edit selection
            </Button>
          </>
        ) : (
          <>
            <p className="jds-hint">
              Choose up to 20 targets. Dated suggestions divide the remaining balance across months
              left, including this month; they recalculate as you save or spend. Monthly and weekly
              contributions count assigned money. Weekly plans cover the full calendar month.
            </p>
            <div className="fnm-block fnm-block--tight">
              {data.lines.map((line) => (
                <div key={line.categoryId} className="fnm-block fnm-block--tight">
                  <Checkbox
                    ariaLabel={`Fund ${line.name}`}
                    label={line.name}
                    checked={ids.includes(line.categoryId)}
                    disabled={
                      busy ||
                      Boolean(line.unavailableReason) ||
                      (ids.length >= 20 && !ids.includes(line.categoryId))
                    }
                    onChange={(checked) =>
                      setIds((old) =>
                        checked
                          ? [...old, line.categoryId]
                          : old.filter((id) => id !== line.categoryId)
                      )
                    }
                  />
                  <p className="jds-hint">
                    {line.unavailableReason
                      ? reason[line.unavailableReason]
                      : `${targetKindLabel(line)}${line.weekly ? ` · ${weeklyPeriodLabel(line.weekly, data.currency, data.month)}` : ""} · add ${formatCents(line.amountCents, data.currency)} · assigned ${formatCents(line.previousCents, data.currency)} → ${formatCents(line.newAssignedCents!, data.currency)}`}
                  </p>
                </div>
              ))}
            </div>
            <p role="status">
              {ids.length} selected
              {ids.length ? ` · ${formatCents(Number(total), data.currency)} to add` : ""}
            </p>
            {selectionError ? <p role="alert">{selectionError}</p> : null}
          </>
        )}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </Dialog>
  );
}
