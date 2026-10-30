import { BillEntryDialog } from "../bill-entry-dialog";
import {
  Badge,
  Button,
  Dialog,
  Masthead,
  Note,
  RowIndex,
  RowIndexItem,
  SectionHead,
  Select,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { BillPlan } from "../../domain/bills";
import { currentMonth, formatCents } from "../format";
import { invalidateQueries, setToolQueryResult, useToolQuery } from "../store";
import { outcomeGate } from "../states";
import { BillAdjustmentDialog } from "../bill-adjustment-dialog";
import { BillPlanDialog } from "../bill-plan-dialog";
import { billMatchCandidates } from "../bill-match-candidates";
export interface Occurrence {
  planId: string;
  name: string;
  accountId: string;
  categoryId: string;
  dueDate: string;
  plannedDate?: string;
  adjusted?: boolean;
  canAdjust?: boolean;
  canRecordEntry?: boolean;
  expectedCents: number;
  state: "projected" | "posted" | "skipped" | "review";
  actualCents: number | null;
  transactionId: string | null;
}
export interface BillsView extends Record<string, unknown> {
  today: string;
  matchFrom?: string;
  matchTo?: string;
  isoCurrency: string;
  revision: number;
  fingerprint: string;
  plans: BillPlan[];
  occurrences: Occurrence[];
  accounts: { accountId: string; name: string }[];
  categories: { id: string; name: string }[];
  transactions: {
    id: string;
    accountId: string;
    date: string;
    name: string;
    amountCents: number;
  }[];
}
export function UpcomingScreen(props: { tools?: ExternalModuleToolsHandleV1 }): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth());
  const [adjusting, setAdjusting] = useState<{ occurrence: Occurrence; reset: boolean } | null>(
    null
  );
  const [recording, setRecording] = useState<Occurrence | null>(null);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Occurrence | null>(null);
  const [stopping, setStopping] = useState<BillPlan | null>(null);
  const [transactionId, setTransaction] = useState("");
  const [endDate, setEndDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const dialogReview = useRef<{ expectedRevision: number; expectedFingerprint: string } | null>(
    null
  );
  const from = `${month}-01`;
  const to = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}`;
  const query = useToolQuery<BillsView>("finance.bills.read", { from, to });
  const data =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;
  const matchCandidates = data && selected ? billMatchCandidates(data.transactions, selected) : [];
  const canMatch = matchCandidates.some((row) => row.id === transactionId);
  useEffect(() => {
    setSelected(null);
    setStopping(null);
    setMessage(null);
  }, [month]);
  const write = async (tool: string, input: Record<string, string>) => {
    if (!props.tools || !data || lock.current || blocked) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools.invoke(tool, {
        ...input,
        ...((selected || stopping) && dialogReview.current
          ? dialogReview.current
          : { expectedRevision: data.revision, expectedFingerprint: data.fingerprint })
      });
      if (result.status === "succeeded" && result.result.status === "ok") {
        setSelected(null);
        setStopping(null);
        invalidateQueries();
      } else if (result.status === "cancelled") setMessage("Cancelled. Your entries are kept.");
      else {
        setBlocked(true);
        setMessage(
          "The review changed or saving could not be confirmed. Check saved bills before trying again. Your entries are kept."
        );
      }
    } catch {
      setBlocked(true);
      setMessage("Check saved bills before trying again. Your entries are kept.");
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  const refresh = async () => {
    if (!props.tools || busy) return;
    setBusy(true);
    try {
      const result = await props.tools.invoke("finance.bills.read", { from, to });
      if (result.status === "succeeded" && result.result.status === "ok") {
        setToolQueryResult("finance.bills.read", { from, to }, result.result);
        setBlocked(false);
        setMessage("Saved bills refreshed. Review the current records before saving.");
      } else setMessage("Bills could not refresh. Try again when the connection returns.");
    } catch {
      setMessage("Bills could not refresh. Try again when the connection returns.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fnm-block" aria-label="Upcoming bills">
      <Masthead
        tone="field"
        eyebrow="Upcoming"
        title="Know what's coming"
        lede="Plan bills, review what posted, and keep your next month in view."
      />
      <div className="fnm-spread">
        <label className="fnm-block fnm-block--tight">
          Month
          <input
            className="jds-input"
            aria-label="Bill month"
            type="month"
            value={month}
            disabled={
              busy ||
              adding ||
              Boolean(selected) ||
              Boolean(stopping) ||
              Boolean(adjusting) ||
              Boolean(recording)
            }
            onChange={(e: { currentTarget: { value: string } }) => {
              if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.currentTarget.value))
                setMonth(e.currentTarget.value);
            }}
          />
        </label>
        <div className="fnm-spread">
          <Button
            variant="secondary"
            disabled={!data || busy || blocked || !props.tools}
            onClick={() => setAdding(true)}
          >
            Add a bill
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !props.tools}
            onClick={() => void refresh()}
          >
            Check saved bills
          </Button>
        </div>
      </div>
      <Note variant="practical">
        Plans are projections. Match posted links an existing expense; Record bill entry adds an
        already-occurred manual expense after review and confirmation. Moss never sends a bank
        payment.
      </Note>
      {message ? <p role="status">{message}</p> : null}
      {outcomeGate(
        query,
        (body) => (
          <div className="fnm-block">
            <SectionHead title="This month's bills" rule />
            {body.occurrences.length ? (
              <RowIndex density="compact">
                {body.occurrences.map((o) => (
                  <RowIndexItem
                    key={`${o.planId}:${o.dueDate}`}
                    title={o.name}
                    excerpt={`${o.plannedDate ?? o.dueDate}${o.adjusted ? ` · one-off change from ${o.dueDate}` : ""} · ${body.accounts.find((a) => a.accountId === o.accountId)?.name ?? "Unavailable account"} · ${body.categories.find((c) => c.id === o.categoryId)?.name ?? "Archived category"}`}
                    meta={
                      <div className="fnm-block fnm-block--tight fnm-end">
                        <strong>{formatCents(o.expectedCents, body.isoCurrency)} expected</strong>
                        <Badge>
                          {o.state === "projected"
                            ? (o.plannedDate ?? o.dueDate) < body.today
                              ? "Past due · projected"
                              : "Projected"
                            : o.state === "posted"
                              ? `Posted ${formatCents(o.actualCents!, body.isoCurrency)}`
                              : o.state === "skipped"
                                ? "Skipped"
                                : "Match needs review"}
                        </Badge>
                        {o.canAdjust ? (
                          <div className="fnm-spread">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy || blocked || !props.tools}
                              onClick={() => setAdjusting({ occurrence: o, reset: false })}
                            >
                              Change this occurrence
                            </Button>
                            {o.adjusted ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy || blocked || !props.tools}
                                onClick={() => setAdjusting({ occurrence: o, reset: true })}
                              >
                                Reset one-off change
                              </Button>
                            ) : null}
                          </div>
                        ) : o.state !== "projected" ? (
                          <p className="jds-hint">Undo review before changing this projection.</p>
                        ) : null}
                        {o.canRecordEntry ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy || blocked || !props.tools}
                            onClick={() => setRecording(o)}
                          >
                            Record bill entry
                          </Button>
                        ) : null}
                        <div className="fnm-spread">
                          {o.state === "projected" ? (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy || blocked || !props.tools}
                                onClick={() => {
                                  dialogReview.current = {
                                    expectedRevision: body.revision,
                                    expectedFingerprint: body.fingerprint
                                  };
                                  setMessage(null);
                                  setSelected(o);
                                  setTransaction("");
                                }}
                              >
                                Match posted
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy || blocked || !props.tools}
                                onClick={() =>
                                  void write("finance.bill.decide", {
                                    planId: o.planId,
                                    dueDate: o.dueDate,
                                    state: "skipped"
                                  })
                                }
                              >
                                Skip occurrence
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy || blocked || !props.tools}
                              onClick={() =>
                                void write("finance.bill.clear", {
                                  planId: o.planId,
                                  dueDate: o.dueDate
                                })
                              }
                            >
                              Undo review
                            </Button>
                          )}
                        </div>
                      </div>
                    }
                  />
                ))}
              </RowIndex>
            ) : (
              <p>No bills planned for this month. Add a bill to see its upcoming dates here.</p>
            )}
            <SectionHead title="Your bill plans" rule />
            {body.plans.length ? (
              <RowIndex density="compact">
                {body.plans.map((p) => (
                  <RowIndexItem
                    key={p.id}
                    title={p.name}
                    excerpt={`${body.accounts.find((a) => a.accountId === p.accountId)?.name ?? "Account unavailable"} · ${p.cadence} from ${p.anchorDate}${p.endDate ? ` · stops after ${p.endDate}` : ""}`}
                    meta={
                      p.endDate && p.endDate <= body.today ? (
                        <Badge>Stopped</Badge>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy || blocked || !props.tools}
                          onClick={() => {
                            dialogReview.current = {
                              expectedRevision: body.revision,
                              expectedFingerprint: body.fingerprint
                            };
                            setMessage(null);
                            setStopping(p);
                            setEndDate(body.today);
                          }}
                        >
                          {p.endDate ? "Stop sooner" : "Stop future bills"}
                        </Button>
                      )
                    }
                  />
                ))}
              </RowIndex>
            ) : (
              <p>No saved plans yet.</p>
            )}
          </div>
        ),
        { loadingLabel: "Loading bills" }
      )}
      {data && recording ? (
        <BillEntryDialog
          data={data}
          occurrence={recording}
          tools={props.tools}
          onClose={() => setRecording(null)}
          onUncertain={() => setBlocked(true)}
        />
      ) : null}
      {data && adjusting ? (
        <BillAdjustmentDialog
          data={data}
          occurrence={adjusting.occurrence}
          reset={adjusting.reset}
          tools={props.tools}
          onClose={() => setAdjusting(null)}
          onUncertain={() => setBlocked(true)}
        />
      ) : null}
      {data && adding ? (
        <BillPlanDialog data={data} tools={props.tools} onClose={() => setAdding(false)} />
      ) : null}
      {data && selected ? (
        <Dialog
          title="Match a posted transaction"
          scrollBody
          closeLabel="Close"
          closeDisabled={busy}
          description={`${selected.name} · ${selected.plannedDate ?? selected.dueDate} · ${formatCents(selected.expectedCents, data.isoCurrency)} expected`}
          onClose={() => {
            if (!busy) setSelected(null);
          }}
          footer={
            <div className="fnm-spread">
              <Button variant="secondary" disabled={busy} onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button
                disabled={!canMatch || busy || blocked}
                onClick={() =>
                  void write("finance.bill.decide", {
                    planId: selected.planId,
                    dueDate: selected.dueDate,
                    state: "matched",
                    transactionId
                  })
                }
              >
                Save match
              </Button>
            </div>
          }
        >
          <div className="fnm-block">
            <p>
              Choose a posted transaction from the same account. Its actual amount may differ. This
              does not edit the transaction.
            </p>
            {data.matchFrom && data.matchTo ? (
              <p className="jds-hint">
                Posted expenses from {data.matchFrom} through {data.matchTo}, including seven days
                either side of this month. Previously matched transactions are excluded.
              </p>
            ) : null}
            {message ? (
              <p role="alert">
                {message} Close this review and check saved bills before trying again.
              </p>
            ) : null}
            <Select
              aria-label="Posted transaction"
              value={transactionId}
              disabled={busy || !matchCandidates.length}
              onChange={(e: { currentTarget: { value: string } }) =>
                setTransaction(e.currentTarget.value)
              }
            >
              <option value="">
                {matchCandidates.length ? "Choose a transaction" : "No posted expenses available"}
              </option>
              {matchCandidates.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.date} · {t.name} · {formatCents(t.amountCents, data.isoCurrency)}
                </option>
              ))}
            </Select>
            {matchCandidates.length ? (
              <p className="jds-hint">
                Nearest date first, then nearest expected amount. Different amounts can still be
                valid. Choose the expense you recognize.
              </p>
            ) : (
              <Note variant="practical">
                No unmatched posted expenses for this account in the shown date range. Check
                Transactions for the payment, then close this review and use Check saved bills.
              </Note>
            )}
          </div>
        </Dialog>
      ) : null}
      {data && stopping ? (
        <Dialog
          title="Stop future bills"
          scrollBody
          closeLabel="Close"
          closeDisabled={busy}
          description={stopping.name}
          onClose={() => {
            if (!busy) setStopping(null);
          }}
          footer={
            <div className="fnm-spread">
              <Button variant="secondary" disabled={busy} onClick={() => setStopping(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy || blocked || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)}
                onClick={() => void write("finance.bill.stop", { id: stopping.id, endDate })}
              >
                Save last planned date
              </Button>
            </div>
          }
        >
          <div className="fnm-block">
            <p>
              Keep occurrences through this date. Later projections disappear; posted transactions
              and reviewed history remain. Undo later bill reviews and reset later one-off changes
              before choosing an earlier stop date.
            </p>
            {message ? (
              <p role="alert">
                {message} Close this review and check saved bills before trying again.
              </p>
            ) : null}
            <label className="fnm-block fnm-block--tight">
              Last planned date, inclusive
              <input
                className="jds-input"
                type="date"
                aria-label="Last planned date"
                value={endDate}
                onChange={(e: { currentTarget: { value: string } }) =>
                  setEndDate(e.currentTarget.value)
                }
              />
            </label>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
