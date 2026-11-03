// external-modules/finance/src/web/attention-list.tsx
//
// "Needs your attention": bills due soon, overspent categories and predicted categories, each
// with a one-tap fix. A fixed row stays in place for ten seconds with Undo, then leaves.
import {
  Badge,
  Button,
  Dialog,
  Eyebrow,
  SectionHead,
  Select,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import {
  attentionRows,
  VISIBLE_ROWS,
  type AttentionRow,
  type PredictedTx,
  type SpendingLine
} from "./attention-model";
import { BillEntryDialog } from "./bill-entry-dialog";
import { occurrenceDate, OccurrencePeek, type OccurrenceHandlers } from "./bill-occurrence";
import type { BudgetStatusResult } from "./budget-status";
import { formatCents, shortDayLabel, weekdayDayLabel } from "./format";
import { navigate } from "./router";
import type { BillsView, Occurrence } from "./screens/upcoming";
import { announce } from "./states";
import { invalidateQueries } from "./store";

const UNDO_WINDOW_MS = 10_000;

interface Fixed {
  row: AttentionRow;
  index: number;
  text: string;
  undo: (() => Promise<boolean>) | null;
}

interface WriteOutcome {
  status: string;
  result?: { status?: string };
}

const succeeded = (outcome: WriteOutcome) =>
  outcome.status === "succeeded" && outcome.result?.status === "ok";

function rowTitle(row: AttentionRow, currency: string): string {
  if (row.kind === "bill") {
    const o = row.occurrence;
    return `${o.name}, ${formatCents(o.expectedCents, currency)}`;
  }
  if (row.kind === "overspent")
    return `${row.line.name} is over by ${formatCents(row.deficitCents, currency)}`;
  if (row.count > 1) return `${row.count} predicted categories`;
  return row.first
    ? `${row.first.name}, ${formatCents(Math.abs(row.first.amountCents), currency)}`
    : "Predicted category";
}

function rowDetail(row: AttentionRow, bills: BillsView | null, currency: string): string {
  if (row.kind === "bill") {
    const o = row.occurrence;
    const date = occurrenceDate(o);
    if (row.match) return `Due ${weekdayDayLabel(date)}. Posted ${shortDayLabel(row.match.date)}`;
    return row.pastDue
      ? `Was due ${weekdayDayLabel(date)}. Nothing posted`
      : `Due ${weekdayDayLabel(date)}`;
  }
  if (row.kind === "overspent")
    return row.source
      ? row.partial
        ? `${row.source.name} has ${formatCents(row.source.availableCents, currency)} left`
        : `${row.source.name} has the most left`
      : "No category has enough";
  void bills;
  if (row.count === 1 && row.first)
    return row.first.categoryName ? `Predicted: ${row.first.categoryName}` : "Predicted category";
  return row.names.join(", ");
}

function Badges(props: { row: AttentionRow }): ReactNodeLike {
  const { row } = props;
  if (row.kind === "bill")
    return row.pastDue ? (
      <Badge tone="red">Past due</Badge>
    ) : (
      <Badge tone={row.match ? "amber" : "neutral"}>Bill</Badge>
    );
  return row.kind === "overspent" ? (
    <Badge tone="red">Overspent</Badge>
  ) : (
    <Badge tone="amber">Predicted</Badge>
  );
}

export function AttentionList(props: {
  tools?: ExternalModuleToolsHandleV1;
  month: string;
  currentMonth: string;
  budget: BudgetStatusResult;
  lines: readonly SpendingLine[];
  bills: BillsView | null;
  predicted: { total: number; rows: PredictedTx[] } | null;
  locked: boolean;
  onUncertain: () => void;
  onRetry: () => void;
  failed: boolean;
}): ReactNodeLike {
  const currency = props.budget.isoCurrency ?? "";
  const [fixed, setFixed] = useState<Record<string, Fixed>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [recording, setRecording] = useState<Occurrence | null>(null);
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const [picking, setPicking] = useState<Extract<AttentionRow, { kind: "overspent" }> | null>(null);
  const [pickedId, setPickedId] = useState("");
  const lock = useRef(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Writes carry the review of the newest read, which lands after each refresh.
  const latest = useRef({ budget: props.budget, bills: props.bills });
  latest.current = { budget: props.budget, bills: props.bills };
  useEffect(
    () => () => {
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
    },
    []
  );

  const live = attentionRows({
    month: props.month,
    currentMonth: props.currentMonth,
    bills: props.bills,
    lines: props.lines,
    predicted: props.predicted
  });
  const rows: { row: AttentionRow; fixed: Fixed | null }[] = live.map((row) => ({
    row,
    fixed: null
  }));
  for (const entry of Object.values(fixed))
    if (!live.some((row) => row.key === entry.row.key))
      rows.splice(Math.min(entry.index, rows.length), 0, { row: entry.row, fixed: entry });

  if (props.failed)
    return (
      <section className="fnm-block fnm-block--tight" aria-label="Needs your attention">
        <div className="fnm-block fnm-block--tiny">
          <Eyebrow tone="gold">Needs your attention</Eyebrow>
          <SectionHead title="Didn't load" rule />
        </div>
        <div>
          <Button variant="secondary" size="sm" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      </section>
    );
  if (!rows.length) return null;

  const write = async (
    row: AttentionRow,
    text: string,
    run: () => Promise<WriteOutcome>,
    undo: (() => Promise<WriteOutcome>) | null
  ) => {
    if (!props.tools || lock.current) return;
    lock.current = true;
    setBusyKey(row.key);
    setMessage(null);
    try {
      const outcome = await run();
      if (succeeded(outcome)) {
        const index = Math.max(
          0,
          rows.findIndex((entry) => entry.row.key === row.key)
        );
        setFixed((old) => ({
          ...old,
          [row.key]: {
            row,
            index,
            text,
            undo: undo
              ? async () => {
                  const back = await undo();
                  return succeeded(back);
                }
              : null
          }
        }));
        timers.current[row.key] = setTimeout(
          () =>
            setFixed((old) => {
              const next = { ...old };
              delete next[row.key];
              return next;
            }),
          UNDO_WINDOW_MS
        );
        announce(text);
        invalidateQueries();
      } else if (outcome.status === "cancelled") setMessage("Cancelled. Nothing was saved.");
      else {
        setMessage("That could not be saved. Check saved records before trying again.");
        props.onUncertain();
        invalidateQueries();
      }
    } catch {
      setMessage("That could not be saved. Check saved records before trying again.");
      props.onUncertain();
    } finally {
      lock.current = false;
      setBusyKey(null);
    }
  };

  const undoRow = async (key: string) => {
    const entry = fixed[key];
    if (!entry?.undo || lock.current) return;
    lock.current = true;
    setBusyKey(key);
    try {
      const ok = await entry.undo();
      if (ok) {
        clearTimeout(timers.current[key]);
        setFixed((old) => {
          const next = { ...old };
          delete next[key];
          return next;
        });
        announce("Undone.");
        invalidateQueries();
      } else {
        setMessage("Couldn't undo that. It may have changed since.");
        invalidateQueries();
      }
    } catch {
      setMessage("Couldn't undo that. It may have changed since.");
    } finally {
      lock.current = false;
      setBusyKey(null);
    }
  };

  const billReview = () => ({
    expectedRevision: latest.current.bills!.revision,
    expectedFingerprint: latest.current.bills!.fingerprint
  });
  const budgetReview = () => ({
    expectedRevision: latest.current.budget.revision!,
    expectedFingerprint: latest.current.budget.fingerprint!
  });
  const decide = (
    row: Extract<AttentionRow, { kind: "bill" }>,
    state: "matched" | "skipped",
    text: string
  ) => {
    const o = row.occurrence;
    void write(
      row,
      text,
      () =>
        props.tools!.invoke("finance.bill.decide", {
          planId: o.planId,
          dueDate: o.dueDate,
          state,
          ...(state === "matched" ? { transactionId: row.match!.transactionId } : {}),
          ...billReview()
        }),
      () =>
        props.tools!.invoke("finance.bill.clear", {
          planId: o.planId,
          dueDate: o.dueDate,
          ...billReview()
        })
    );
  };
  const move = (
    row: Extract<AttentionRow, { kind: "overspent" }>,
    source: { id: string; name: string },
    cents: number
  ) => {
    const run = (from: string, to: string) =>
      props.tools!.invoke("finance.budget.move", {
        month: props.month,
        fromCategoryId: from,
        toCategoryId: to,
        amountCents: cents,
        ...budgetReview()
      });
    void write(
      row,
      `Moved ${formatCents(cents, currency)} from ${source.name} to ${row.line.name}.`,
      () => run(source.id, row.line.id),
      () => run(row.line.id, source.id)
    );
  };
  const confirm = (row: Extract<AttentionRow, { kind: "predicted" }>, txs: PredictedTx[]) =>
    void write(
      row,
      txs.length === 1 ? "Confirmed." : `Confirmed ${txs.length} predicted categories.`,
      () =>
        props.tools!.invoke("finance.transactions.confirm", {
          rows: txs.map((tx) => ({ id: tx.id, writeRevision: tx.writeRevision! }))
        }),
      null
    );

  const handlersFor = (): OccurrenceHandlers => ({
    disabled: props.locked || !props.tools,
    onAdjust: () => navigate("/upcoming"),
    onRecord: (o) => {
      setPeekKey(null);
      setRecording(o);
    },
    onMatch: () => navigate("/upcoming"),
    onSkip: (o) => {
      const entry = live.find((r) => r.kind === "bill" && r.occurrence === o);
      setPeekKey(null);
      if (entry && entry.kind === "bill") decide(entry, "skipped", `Skipped ${o.name}.`);
    },
    onUndo: () => navigate("/upcoming")
  });

  const actions = (row: AttentionRow): ReactNodeLike => {
    const off = props.locked || !props.tools || busyKey !== null;
    if (row.kind === "bill") {
      const o = row.occurrence;
      const name = `${o.name}, ${shortDayLabel(occurrenceDate(o))}`;
      return (
        <>
          {row.match ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={off}
              aria-label={`Match ${formatCents(row.match.cents, currency)}, ${name}`}
              onClick={() => decide(row, "matched", `Matched ${o.name}.`)}
            >
              Match {formatCents(row.match.cents, currency)}
            </Button>
          ) : o.canRecordEntry ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={off}
              aria-label={`Record payment, ${name}`}
              onClick={() => setRecording(o)}
            >
              Record payment
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="quiet"
            disabled={off}
            aria-label={`Skip, ${name}`}
            onClick={() => decide(row, "skipped", `Skipped ${o.name}.`)}
          >
            Skip
          </Button>
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Open, ${name}`}
            onClick={() => setPeekKey(row.key)}
          >
            Open
          </Button>
        </>
      );
    }
    if (row.kind === "overspent") {
      const name = row.line.name;
      return (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={off || !row.source}
            aria-label={
              row.source
                ? `${row.partial ? "Cover part" : "Cover"} ${name} from ${row.source.name}`
                : `Cover ${name}`
            }
            onClick={() =>
              row.source &&
              move(row, row.source, Math.min(row.deficitCents, row.source.availableCents))
            }
          >
            {row.source
              ? `${row.partial ? "Cover part from" : "Cover from"} ${row.source.name}`
              : "Cover"}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={off}
            aria-label={`Pick another category to cover ${name}`}
            onClick={() => {
              setPickedId("");
              setPicking(row);
            }}
          >
            Pick another
          </Button>
        </>
      );
    }
    return (
      <>
        {row.confirmable?.every((tx) => tx.writeRevision) ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={off}
            onClick={() => confirm(row, row.confirmable!)}
          >
            {row.count > 1 ? `Confirm all ${row.count}` : "Confirm"}
          </Button>
        ) : null}
        <Button size="sm" variant="quiet" onClick={() => navigate("/transactions?filter=look")}>
          Review
        </Button>
      </>
    );
  };

  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);
  const peeked = peekKey ? live.find((r) => r.key === peekKey) : null;
  const pickChoices = picking
    ? props.lines.filter((line) => line.id !== picking.line.id && line.available > 0)
    : [];
  const picked = pickChoices.find((line) => line.id === pickedId);
  return (
    <section className="fnm-block fnm-block--tight" aria-label="Needs your attention">
      <div className="fnm-block fnm-block--tiny">
        <Eyebrow tone="gold">Needs your attention</Eyebrow>
        <SectionHead title={rows.length === 1 ? "1 thing" : `${rows.length} things`} rule />
      </div>
      {message ? <p role="status">{message}</p> : null}
      <div className="fnm-attn-list">
        {shown.map(({ row, fixed: done }) => (
          <div key={row.key} className={`fnm-attn-row${done ? " fnm-attn-row--done" : ""}`}>
            <div className="fnm-attn-text">
              <div className="fnm-attn-what">
                {done ? null : <Badges row={row} />}
                <span>{done ? done.text : rowTitle(row, currency)}</span>
              </div>
              {done ? null : (
                <span className="jds-hint">{rowDetail(row, props.bills, currency)}</span>
              )}
            </div>
            <div className="fnm-attn-acts">
              {done ? (
                done.undo ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={busyKey !== null}
                    onClick={() => void undoRow(row.key)}
                  >
                    Undo
                  </Button>
                ) : null
              ) : (
                actions(row)
              )}
            </div>
          </div>
        ))}
      </div>
      {rows.length > VISIBLE_ROWS && !expanded ? (
        <div>
          <Button variant="quiet" size="sm" onClick={() => setExpanded(true)}>
            Show {rows.length - VISIBLE_ROWS} more
          </Button>
        </div>
      ) : null}
      {props.bills && recording ? (
        <BillEntryDialog
          data={props.bills}
          occurrence={recording}
          tools={props.tools}
          onClose={() => setRecording(null)}
          onUncertain={props.onUncertain}
        />
      ) : null}
      {props.bills && peeked?.kind === "bill" ? (
        <OccurrencePeek
          occurrence={peeked.occurrence}
          view={props.bills}
          onClose={() => setPeekKey(null)}
          {...handlersFor()}
        />
      ) : null}
      {picking ? (
        <Dialog
          title={`Cover ${picking.line.name}`}
          closeLabel="Close"
          onClose={() => setPicking(null)}
          footer={
            <div className="fnm-spread">
              <Button variant="secondary" onClick={() => setPicking(null)}>
                Cancel
              </Button>
              <Button
                disabled={!picked}
                onClick={() => {
                  if (!picked) return;
                  const cents = Math.min(picking.deficitCents, picked.available);
                  setPicking(null);
                  move(picking, picked, cents);
                }}
              >
                Move money
              </Button>
            </div>
          }
        >
          <Select
            aria-label="Take the money from"
            value={pickedId}
            onChange={(e: { currentTarget: { value: string } }) =>
              setPickedId(e.currentTarget.value)
            }
          >
            <option value="">Choose a category</option>
            {pickChoices.map((line) => (
              <option key={line.id} value={line.id}>
                {line.name}, {formatCents(line.available, currency)} left
              </option>
            ))}
          </Select>
        </Dialog>
      ) : null}
    </section>
  );
}
