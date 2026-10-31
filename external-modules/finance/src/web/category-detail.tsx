// external-modules/finance/src/web/category-detail.tsx
// The category detail panel: this month's figures, the target, quick amounts and Move money.
//
// Quick amounts only fill the Assigned field; the reviewed assign path still saves them. Each
// figure comes from a budget read the screen already uses, and one that cannot be worked out is
// left out rather than shown as zero.
import {
  Button,
  Eyebrow,
  Field,
  FormLabel,
  PeekCloseButton,
  PeekPanel,
  RowIndex,
  RowIndexItem,
  Segmented,
  Select,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { BudgetStatusResult } from "./budget-status";
import { AvailableCell, money, ZERO, type Line } from "./budget-table";
import { monthLabel, parseAmountToCents, shiftMonth } from "./format";
import { announce } from "./states";
import { invalidateQueries, useToolQuery } from "./store";
import type { TargetProgress } from "../domain/targets";

const READY_TO_ASSIGN = "ready_to_assign";

interface QuickAmount {
  label: string;
  cents: number;
}

type MonthRead = ReturnType<typeof useToolQuery<BudgetStatusResult>>;

/** A month counts only when it read cleanly, in the same currency, with this category and data. */
function monthFigures(read: MonthRead, line: Line) {
  if (read.status !== "settled" || read.outcome.kind !== "ok") return null;
  const result = read.outcome.result;
  if (
    result.setupRequired ||
    result.isoCurrency !== line.currency ||
    !result.categories?.some((category) => category.id === line.id) ||
    Object.keys(result.state?.categories ?? {}).length === 0
  )
    return null;
  const row = result.state!.categories[line.id] ?? ZERO;
  return { assigned: row.assignedCents, spent: row.activityCents };
}

export function quickAmounts(
  line: Line,
  target: TargetProgress | undefined,
  months: ({ assigned: number; spent: number } | null)[]
): QuickAmount[] {
  const amounts: QuickAmount[] = [];
  if (target && target.suggestedCents > 0)
    amounts.push({ label: "Fund target", cents: line.assigned + target.suggestedCents });
  const [last] = months;
  if (last) {
    amounts.push({ label: "Assigned last month", cents: last.assigned });
    amounts.push({ label: "Spent last month", cents: last.spent });
  }
  if (months.length === 3 && months.every(Boolean)) {
    const total = months.reduce((sum, month) => sum + month!.spent, 0);
    amounts.push({ label: "Average spent, 3 months", cents: Math.round(total / 3) });
  }
  // Zero is one keystroke away, and a figure equal to today's adds nothing.
  return amounts.filter(
    (amount) =>
      Number.isSafeInteger(amount.cents) && amount.cents > 0 && amount.cents !== line.assigned
  );
}

function targetText(target: TargetProgress, currency: string): string {
  const amount = money(target.weekly?.totalCents ?? target.amountCents, currency);
  const goal =
    target.kind === "monthly"
      ? `${amount} each month`
      : target.kind === "weekly"
        ? `${money(target.amountCents, currency)} each week`
        : target.kind === "refill"
          ? `Refill to ${amount}`
          : target.dueDate
            ? `${amount} by ${target.dueDate}`
            : `${amount} saved`;
  return target.status === "reached"
    ? `${goal}, reached`
    : `${goal}, ${money(target.remainingCents, currency)} to go`;
}

const MOVE_ERRORS: Record<string, string> = {
  not_enough_ready: "That is more than Ready to assign holds.",
  not_enough_available: "That is more than the other category has available.",
  funding_unavailable: "Ready to assign is unavailable this month.",
  invalid_category: "Choose a current category.",
  stale_budget: "The budget changed. Review the new figures and try again."
};

function MoveMoney(props: {
  line: Line;
  month: string;
  others: Line[];
  readyCents: number | null;
  review: { revision: number; fingerprint: string } | null;
  locked: boolean;
  lockedReason: string | null;
  tools?: ExternalModuleToolsHandleV1;
  onUncertain: () => void;
}): ReactNodeLike {
  const { line } = props;
  const [direction, setDirection] = useState<"in" | "out">(line.available < 0 ? "in" : "out");
  const [other, setOther] = useState(
    line.available < 0 ? READY_TO_ASSIGN : (props.others[0]?.id ?? "")
  );
  const [amount, setAmount] = useState(
    line.available < 0 ? money(-line.available, line.currency) : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const choices =
    direction === "in"
      ? [READY_TO_ASSIGN, ...props.others.map((o) => o.id)]
      : props.others.map((o) => o.id);
  const chosen = choices.includes(other) ? other : (choices[0] ?? "");
  const nameOf = (id: string) =>
    id === READY_TO_ASSIGN
      ? "Ready to assign"
      : (props.others.find((o) => o.id === id)?.name ?? id);
  const sourceCents =
    direction === "out"
      ? line.available
      : chosen === READY_TO_ASSIGN
        ? props.readyCents
        : (props.others.find((o) => o.id === chosen)?.available ?? null);
  const disabled = props.locked || busy || !props.tools || !props.review || !chosen;
  const submit = () => {
    if (disabled) return;
    const cents = parseAmountToCents(amount);
    if (cents === null || cents <= 0) {
      setError("Enter an amount like 25 or 25.50.");
      return;
    }
    if (sourceCents !== null && cents > sourceCents) {
      setError(
        direction === "out"
          ? `${line.name} has ${money(Math.max(0, line.available), line.currency)} available.`
          : `${nameOf(chosen)} has ${money(Math.max(0, sourceCents), line.currency)} available.`
      );
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const outcome = await props.tools!.invoke("finance.budget.move", {
          month: props.month,
          fromCategoryId: direction === "in" ? chosen : line.id,
          toCategoryId: direction === "in" ? line.id : chosen,
          amountCents: cents,
          expectedRevision: props.review!.revision,
          expectedFingerprint: props.review!.fingerprint
        });
        if (!mounted.current) return;
        if (outcome.status === "succeeded" && outcome.result.status === "ok") {
          setAmount("");
          announce(
            direction === "in"
              ? `Moved ${money(cents, line.currency)} to ${line.name}.`
              : `Moved ${money(cents, line.currency)} to ${nameOf(chosen)}.`
          );
          invalidateQueries();
        } else if (outcome.status === "cancelled") {
          setError("Cancelled. Nothing moved.");
        } else if (outcome.status === "rejected") {
          setError(
            MOVE_ERRORS[outcome.moduleCode ?? ""] ?? "Not moved. Review the figures and try again."
          );
          invalidateQueries();
        } else if (outcome.status === "invalid_input") {
          setError("Enter an amount like 25 or 25.50.");
        } else {
          setError("The move could not be confirmed. Check saved records before trying again.");
          props.onUncertain();
        }
      } catch {
        if (!mounted.current) return;
        setError("The move could not be confirmed. Check saved records before trying again.");
        props.onUncertain();
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  };
  return (
    <section className="fnm-block fnm-block--tight">
      <Eyebrow as="h3">Move money</Eyebrow>
      <Segmented
        ariaLabel="Move direction"
        value={direction}
        onChange={(value: "in" | "out") => {
          setDirection(value);
          setError(null);
        }}
        options={[
          { value: "in", label: "Move in" },
          { value: "out", label: "Move out" }
        ]}
      />
      <div className="fnm-move">
        <Field>
          <FormLabel htmlFor="fnm-move-amount">Amount</FormLabel>
          <input
            id="fnm-move-amount"
            className="jds-input"
            aria-label="Amount to move"
            inputMode="decimal"
            value={amount}
            disabled={busy}
            onChange={(event: { currentTarget: { value: string } }) => {
              setAmount(event.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(event: { key: string; preventDefault: () => void }) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        <Field>
          <FormLabel htmlFor="fnm-move-other">{direction === "in" ? "From" : "To"}</FormLabel>
          <Select
            id="fnm-move-other"
            aria-label={direction === "in" ? "Move from" : "Move to"}
            value={chosen}
            disabled={busy || choices.length === 0}
            onChange={(event: { currentTarget: { value: string } }) => {
              setOther(event.currentTarget.value);
              setError(null);
            }}
          >
            {choices.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="fnm-chips">
        <Button size="sm" disabled={disabled} onClick={submit}>
          {busy ? "Moving…" : "Move"}
        </Button>
      </div>
      {props.locked && props.lockedReason && !busy ? (
        <p className="jds-hint" role="status">
          {props.lockedReason}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="jds-hint">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function CategoryDetail(props: {
  line: Line;
  month: string;
  result: BudgetStatusResult;
  others: Line[];
  /** Quick amounts wait while this line's Assigned field cannot take a typed amount. */
  fillLocked: boolean;
  /** Move money waits while typed amounts, a save or a check are in progress. */
  locked: boolean;
  /** Shown while locked, when the wait needs the person to act. */
  lockedReason: string | null;
  tools?: ExternalModuleToolsHandleV1;
  returnFocusRef: { current: HTMLElement | null };
  onQuickAmount: (cents: number) => void;
  onUncertain: () => void;
  onClose: () => void;
}): ReactNodeLike {
  const { line, result } = props;
  const reads = [
    useToolQuery<BudgetStatusResult>("finance.budget.status", {
      month: shiftMonth(props.month, -1)
    }),
    useToolQuery<BudgetStatusResult>("finance.budget.status", {
      month: shiftMonth(props.month, -2)
    }),
    useToolQuery<BudgetStatusResult>("finance.budget.status", {
      month: shiftMonth(props.month, -3)
    })
  ];
  const loading = reads.some((read) => read.status !== "settled");
  const target = result.targets?.find(
    (candidate) => candidate.categoryId === line.id && candidate.kind !== "removed"
  );
  const amounts = quickAmounts(
    line,
    target,
    reads.map((read) => monthFigures(read, line))
  );
  const review =
    result.revision !== undefined && result.fingerprint
      ? { revision: result.revision, fingerprint: result.fingerprint }
      : null;
  return (
    <PeekPanel
      modal
      onClose={props.onClose}
      aria-labelledby="fnm-detail-title"
      returnFocusRef={props.returnFocusRef}
    >
      <div className="cal-peek__head">
        <Eyebrow tone="gold">{monthLabel(props.month)}</Eyebrow>
        <PeekCloseButton aria-label="Close category details" onClick={props.onClose} />
      </div>
      <div className="fnm-peek">
        <h2 className="cal-peek__title" id="fnm-detail-title">
          {line.name}
        </h2>
        <RowIndex variant="facts">
          <RowIndexItem title="Assigned" meta={money(line.assigned, line.currency)} />
          <RowIndexItem title="Spent" meta={money(line.spent, line.currency)} />
          <RowIndexItem
            title="Available"
            meta={<AvailableCell cents={line.available} currency={line.currency} />}
          />
          {target ? <RowIndexItem title="Target" meta={targetText(target, line.currency)} /> : null}
        </RowIndex>
        {amounts.length || loading ? (
          <section className="fnm-block fnm-block--tight">
            <Eyebrow as="h3">Quick amounts</Eyebrow>
            {amounts.length ? (
              <RowIndex variant="facts">
                {amounts.map((amount) => (
                  <RowIndexItem
                    key={amount.label}
                    title={amount.label}
                    meta={
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={props.fillLocked}
                        aria-label={`Use ${money(amount.cents, line.currency)}, ${amount.label.toLowerCase()}`}
                        onClick={() => props.onQuickAmount(amount.cents)}
                      >
                        {money(amount.cents, line.currency)}
                      </Button>
                    }
                  />
                ))}
              </RowIndex>
            ) : null}
            {loading ? (
              <p className="jds-hint" role="status">
                Loading earlier months
              </p>
            ) : null}
          </section>
        ) : null}
        {props.others.length || line.available < 0 || result.readyToAssignCents ? (
          <MoveMoney
            line={line}
            month={props.month}
            others={props.others}
            readyCents={result.readyToAssignCents ?? null}
            review={review}
            locked={props.locked}
            lockedReason={props.lockedReason}
            tools={props.tools}
            onUncertain={props.onUncertain}
          />
        ) : null}
      </div>
    </PeekPanel>
  );
}
