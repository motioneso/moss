import { BillEntryDialog } from "../bill-entry-dialog";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Eyebrow,
  Menu,
  Note,
  PeriodStepper,
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
import {
  cadenceText,
  currentMonth,
  dayYearLabel,
  formatCents,
  monthLabel,
  shiftMonth,
  shortDayLabel,
  weekdayDayLabel
} from "../format";
import { MoreIcon } from "../icons";
import { navigate } from "../router";
import {
  invalidateQueries,
  publishToolRefresh,
  useToolQuery,
  useToolQueryRefreshing
} from "../store";
import { LoadingState, outcomeGate } from "../states";
import { BillAdjustmentDialog } from "../bill-adjustment-dialog";
import { BillPlanDialog, type BillPlanDraft } from "../bill-plan-dialog";
import { billMatchCandidates } from "../bill-match-candidates";
import { BillCalendar, billWeeks, weekLabel } from "../bill-calendar";
import {
  accountName,
  billTotals,
  categoryName,
  OccurrenceActions,
  OccurrencePeek,
  occurrenceDate,
  occurrenceKey,
  quietState,
  stateLabel,
  type OccurrenceHandlers
} from "../bill-occurrence";
import {
  BillSuggestions,
  type BillSuggestionsResult,
  type BillSuggestionView
} from "../bill-suggestions";
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
  setupRequired?: boolean;
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
function totalsLine(view: BillsView): string | null {
  if (!view.occurrences.length) return null;
  const totals = billTotals(view.occurrences);
  const money = (cents: number) => formatCents(cents, view.isoCurrency);
  return `${money(totals.due)} due · ${money(totals.paid)} paid · ${money(totals.toGo)} to go`;
}

const planStopped = (plan: BillPlan, today: string) =>
  Boolean(plan.endDate && plan.endDate <= today);

function PlanActions(props: {
  plan: BillPlan;
  disabled: boolean;
  onStop: () => void;
}): ReactNodeLike {
  const { name, endDate } = props.plan;
  return (
    <Menu
      triggerVariant="icon"
      triggerIcon={<MoreIcon />}
      triggerLabel={`Actions for ${name}`}
      items={[
        endDate
          ? { id: "stop", label: "Stop sooner", ariaLabel: `Stop ${name} sooner` }
          : { id: "stop", label: "Stop future bills", ariaLabel: `Stop future bills for ${name}` }
      ].map((item) => ({ ...item, disabled: props.disabled }))}
      onSelect={props.onStop}
    />
  );
}

export function UpcomingScreen(props: { tools?: ExternalModuleToolsHandleV1 }): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth());
  const [adjusting, setAdjusting] = useState<{ occurrence: Occurrence; reset: boolean } | null>(
    null
  );
  const [recording, setRecording] = useState<Occurrence | null>(null);
  const [adding, setAdding] = useState<{ initial?: BillPlanDraft } | null>(null);
  const [peekKey, setPeekKey] = useState<string | null>(null);
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
  const settled =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;
  const data = settled?.setupRequired ? null : settled;
  const suggestionsQuery = useToolQuery<BillSuggestionsResult>("finance.bills.suggestions", {});
  // A failed suggestions read only hides the section.
  const suggestions =
    suggestionsQuery.status === "settled" && suggestionsQuery.outcome.kind === "ok"
      ? (suggestionsQuery.outcome.result.suggestions ?? [])
      : [];
  // Every bill write carries the review it was shown, so wait for the read that follows a write.
  const refreshing = useToolQueryRefreshing("finance.bills.read", { from, to });
  const suggestionsRefreshing = useToolQueryRefreshing("finance.bills.suggestions", {});
  const peek = (peekKey && data?.occurrences.find((o) => occurrenceKey(o) === peekKey)) || null;
  const matchCandidates = data && selected ? billMatchCandidates(data.transactions, selected) : [];
  const canMatch = matchCandidates.some((row) => row.id === transactionId);
  useEffect(() => {
    setSelected(null);
    setStopping(null);
    setPeekKey(null);
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
        publishToolRefresh("finance.bills.read", { from, to }, result.result);
        setBlocked(false);
        setMessage("Saved bills refreshed. Review the current records before saving.");
      } else setMessage("Bills could not refresh. Try again when the connection returns.");
    } catch {
      setMessage("Bills could not refresh. Try again when the connection returns.");
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || blocked || refreshing || !props.tools;
  const handlers: OccurrenceHandlers = {
    disabled,
    onAdjust: (occurrence, reset) => setAdjusting({ occurrence, reset }),
    onRecord: setRecording,
    onMatch: (o) => {
      if (!data) return;
      dialogReview.current = {
        expectedRevision: data.revision,
        expectedFingerprint: data.fingerprint
      };
      setMessage(null);
      setSelected(o);
      setTransaction("");
    },
    onSkip: (o) =>
      void write("finance.bill.decide", { planId: o.planId, dueDate: o.dueDate, state: "skipped" }),
    onUndo: (o) => void write("finance.bill.clear", { planId: o.planId, dueDate: o.dueDate })
  };
  const addSuggestion = (s: BillSuggestionView) =>
    setAdding({
      initial: {
        name: s.name,
        accountId: s.accountId,
        categoryId: s.categoryId,
        amountCents: s.amountCents,
        anchorDate: s.nextDate,
        cadence: s.cadence
      }
    });
  const actions = (
    <>
      {blocked ? (
        <Button variant="secondary" disabled={busy || !props.tools} onClick={() => void refresh()}>
          Check saved bills
        </Button>
      ) : null}
      <Button disabled={disabled} onClick={() => setAdding({})}>
        Add a bill
      </Button>
    </>
  );
  const suggested = (view: BillsView, head?: ReactNodeLike) =>
    suggestions.length ? (
      <BillSuggestions
        suggestions={suggestions}
        isoCurrency={view.isoCurrency}
        disabled={disabled || suggestionsRefreshing}
        tools={props.tools}
        onAdd={addSuggestion}
        actions={head}
      />
    ) : null;
  // With no plans the month does not matter, so the empty page carries the actions.
  const noPlans = Boolean(data && !data.plans.length);
  return (
    <section className="fnm-block" aria-label="Upcoming bills">
      {noPlans ? null : (
        <div className="fnm-spread">
          <PeriodStepper
            label={monthLabel(month)}
            previousLabel={monthLabel(shiftMonth(month, -1))}
            nextLabel={monthLabel(shiftMonth(month, 1))}
            onPrevious={() => setMonth(shiftMonth(month, -1))}
            onNext={() => setMonth(shiftMonth(month, 1))}
            disabled={
              busy ||
              Boolean(adding) ||
              Boolean(peek) ||
              Boolean(selected) ||
              Boolean(stopping) ||
              Boolean(adjusting) ||
              Boolean(recording)
            }
          />
          {data ? <div className="fnm-chips">{actions}</div> : null}
        </div>
      )}

      {message ? <p role="status">{message}</p> : null}
      {outcomeGate(
        query,
        (body) =>
          body.setupRequired ? (
            <EmptyState
              title="Choose a budget currency"
              actions={<Button onClick={() => navigate("/")}>Open Budget</Button>}
            />
          ) : !body.plans.length ? (
            suggestionsQuery.status === "loading" ? (
              <LoadingState label="Loading bills" />
            ) : (
              (suggested(body, <div className="fnm-chips">{actions}</div>) ?? (
                <EmptyState title="No bills yet" actions={actions} />
              ))
            )
          ) : (
            <div className="fnm-block">
              <div className="fnm-block fnm-block--tight">
                <SectionHead title="Bills due" meta={totalsLine(body)} rule wrap />
                {body.occurrences.length ? (
                  <>
                    <BillCalendar
                      month={month}
                      view={body}
                      onOpen={(o) => setPeekKey(occurrenceKey(o))}
                    />
                    <div className="fnm-weeks">
                      {billWeeks(body.occurrences).map((week) => (
                        <div className="fnm-week" key={week.start}>
                          <Eyebrow as="h3">{weekLabel(week.start)}</Eyebrow>
                          <RowIndex density="compact">
                            {week.items.map((o) => (
                              <RowIndexItem
                                key={occurrenceKey(o)}
                                title={o.name}
                                excerpt={[
                                  weekdayDayLabel(occurrenceDate(o)),
                                  o.adjusted
                                    ? `one-off change from ${shortDayLabel(o.dueDate)}`
                                    : null,
                                  accountName(body, o.accountId),
                                  categoryName(body, o.categoryId)
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                                meta={
                                  <div className="fnm-occ">
                                    <div className="fnm-inline">
                                      {quietState(o, body) ? null : (
                                        <Badge>{stateLabel(o, body)}</Badge>
                                      )}
                                      <strong>
                                        {formatCents(o.expectedCents, body.isoCurrency)} expected
                                      </strong>
                                    </div>
                                    <OccurrenceActions occurrence={o} {...handlers} />
                                    <span className="fnm-occ__open">
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        aria-label={`Details, ${o.name}`}
                                        onClick={() => setPeekKey(occurrenceKey(o))}
                                      >
                                        Details
                                      </Button>
                                    </span>
                                  </div>
                                }
                              />
                            ))}
                          </RowIndex>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="jds-hint" role="status">
                    Nothing due in {monthLabel(month)}.
                  </p>
                )}
              </div>
              {suggested(body)}
              <div className="fnm-block fnm-block--tight">
                <SectionHead title="Your bill plans" rule />
                <RowIndex density="compact" narrowMeta="beside">
                  {[...body.plans]
                    .sort(
                      (a, b) =>
                        Number(planStopped(a, body.today)) - Number(planStopped(b, body.today))
                    )
                    .map((p) => {
                      const stopped = planStopped(p, body.today);
                      const amount = formatCents(p.amountCents, p.isoCurrency);
                      return (
                        <RowIndexItem
                          key={p.id}
                          title={p.name}
                          excerpt={[
                            accountName(body, p.accountId),
                            `${cadenceText(p.cadence)} from ${dayYearLabel(p.anchorDate, "short")}`,
                            p.endDate
                              ? `${stopped ? "stopped" : "stops"} after ${dayYearLabel(p.endDate, "short")}`
                              : null
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          meta={
                            stopped ? (
                              <span className="fnm-amount">{amount}</span>
                            ) : (
                              <>
                                <strong className="fnm-amount">{amount}</strong>
                                <PlanActions
                                  plan={p}
                                  disabled={disabled}
                                  onStop={() => {
                                    dialogReview.current = {
                                      expectedRevision: body.revision,
                                      expectedFingerprint: body.fingerprint
                                    };
                                    setMessage(null);
                                    setStopping(p);
                                    setEndDate(body.today);
                                  }}
                                />
                              </>
                            )
                          }
                        />
                      );
                    })}
                </RowIndex>
              </div>
            </div>
          ),
        { loadingLabel: "Loading bills", errorMessage: "Your bills didn't load." }
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
      {data && peek ? (
        <OccurrencePeek
          occurrence={peek}
          view={data}
          onClose={() => setPeekKey(null)}
          {...handlers}
        />
      ) : null}
      {data && adding ? (
        <BillPlanDialog
          data={data}
          initial={adding.initial}
          tools={props.tools}
          onClose={() => setAdding(null)}
        />
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
              Bills after this date come off the calendar. Paid and reviewed bills stay. To stop
              before a bill you reviewed or changed, undo that first.
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
