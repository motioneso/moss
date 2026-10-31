import {
  Badge,
  Button,
  Eyebrow,
  PeekCloseButton,
  PeekPanel,
  RowIndex,
  RowIndexItem,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { BillsView, Occurrence } from "./screens/upcoming";
import { formatCents, shortDayLabel, weekdayDayLabel } from "./format";

/** The date a bill lands on this month, after any one-off change. */
export const occurrenceDate = (o: Occurrence) => o.plannedDate ?? o.dueDate;
export const occurrenceKey = (o: Pick<Occurrence, "planId" | "dueDate">) =>
  `${o.planId}:${o.dueDate}`;

const pastDue = (o: Occurrence, today: string) =>
  o.state === "projected" && occurrenceDate(o) < today;

export function stateLabel(o: Occurrence, view: BillsView): string {
  if (o.state === "projected") return pastDue(o, view.today) ? "Past due · projected" : "Projected";
  if (o.state === "posted") return `Posted ${formatCents(o.actualCents!, view.isoCurrency)}`;
  return o.state === "skipped" ? "Skipped" : "Match needs review";
}

/** A bill still due on time needs no badge in the list; the panel still names it. */
export const quietState = (o: Occurrence, view: BillsView) =>
  o.state === "projected" && !pastDue(o, view.today);

const stateWords = (o: Occurrence, today: string) =>
  o.state === "posted"
    ? "paid"
    : o.state === "skipped"
      ? "skipped"
      : o.state === "review"
        ? "match needs review"
        : pastDue(o, today)
          ? "past due"
          : "due";

/** Calendar chip: dot colour, settled look, and a spoken label that says the state in words. */
export function occurrenceChip(o: Occurrence, view: BillsView) {
  const cents = o.state === "posted" ? o.actualCents! : o.expectedCents;
  const amount = formatCents(cents, view.isoCurrency);
  return {
    amount,
    color:
      o.state === "posted"
        ? "var(--accent-fg)"
        : o.state === "skipped"
          ? "var(--border-strong)"
          : o.state === "review" || pastDue(o, view.today)
            ? "var(--warning)"
            : "var(--steel)",
    muted: o.state === "posted" || o.state === "skipped",
    struck: o.state === "skipped",
    label: `${o.name}, ${shortDayLabel(occurrenceDate(o))}, ${amount}, ${stateWords(o, view.today)}`
  };
}

/** Month totals for the section head. Skipped bills count nowhere. */
export function billTotals(occurrences: readonly Occurrence[]) {
  let paid = 0,
    toGo = 0;
  for (const o of occurrences)
    if (o.state === "posted") paid += o.actualCents ?? 0;
    else if (o.state !== "skipped") toGo += o.expectedCents;
  return { due: paid + toGo, paid, toGo };
}

export interface OccurrenceHandlers {
  disabled: boolean;
  onAdjust: (o: Occurrence, reset: boolean) => void;
  onRecord: (o: Occurrence) => void;
  onMatch: (o: Occurrence) => void;
  onSkip: (o: Occurrence) => void;
  onUndo: (o: Occurrence) => void;
}

/** The same bill actions in a list row and in the detail panel, commonest first. */
export function OccurrenceActions(
  props: { occurrence: Occurrence } & OccurrenceHandlers
): ReactNodeLike {
  const o = props.occurrence;
  // Weekly bills repeat, so every button names its bill and day after the visible action.
  const target = `${o.name}, ${shortDayLabel(occurrenceDate(o))}`;
  const action = (label: string, run: () => void) => (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`${label}, ${target}`}
      disabled={props.disabled}
      onClick={run}
    >
      {label}
    </Button>
  );
  return (
    <div className="fnm-chips fnm-occ__actions">
      {o.state === "projected" ? (
        <>
          {action("Match posted", () => props.onMatch(o))}
          {action("Skip occurrence", () => props.onSkip(o))}
        </>
      ) : (
        action("Undo review", () => props.onUndo(o))
      )}
      {o.canRecordEntry ? action("Record bill entry", () => props.onRecord(o)) : null}
      {o.canAdjust ? action("Change this occurrence", () => props.onAdjust(o, false)) : null}
      {o.canAdjust && o.adjusted
        ? action("Reset one-off change", () => props.onAdjust(o, true))
        : null}
    </div>
  );
}

export const accountName = (view: BillsView, id: string) =>
  view.accounts.find((a) => a.accountId === id)?.name ?? "Unavailable account";
export const categoryName = (view: BillsView, id: string) =>
  view.categories.find((c) => c.id === id)?.name ?? "Archived category";

/** The detail panel for one bill, opened from a calendar chip or a list row. */
export function OccurrencePeek(
  props: {
    occurrence: Occurrence;
    view: BillsView;
    onClose: () => void;
  } & OccurrenceHandlers
): ReactNodeLike {
  const { occurrence: o, view } = props;
  return (
    <PeekPanel modal onClose={props.onClose} aria-labelledby="fnm-bill-title">
      <div className="cal-peek__head">
        <Eyebrow tone="gold">{weekdayDayLabel(occurrenceDate(o))}</Eyebrow>
        <PeekCloseButton aria-label="Close bill details" onClick={props.onClose} />
      </div>
      <div className="fnm-peek">
        <h2 className="cal-peek__title" id="fnm-bill-title">
          {o.name}
        </h2>
        <RowIndex variant="facts">
          <RowIndexItem title="Expected" meta={formatCents(o.expectedCents, view.isoCurrency)} />
          <RowIndexItem title="Status" meta={<Badge>{stateLabel(o, view)}</Badge>} />
          {o.adjusted ? <RowIndexItem title="Usually due" meta={shortDayLabel(o.dueDate)} /> : null}
          <RowIndexItem title="Account" meta={accountName(view, o.accountId)} />
          <RowIndexItem title="Category" meta={categoryName(view, o.categoryId)} />
        </RowIndex>
        <OccurrenceActions {...props} />
      </div>
    </PeekPanel>
  );
}
