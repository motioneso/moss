// external-modules/finance/src/web/month-strip.tsx
//
// "This month": income so far, spent, left to spend, bills due and overspent.
import { Eyebrow, SectionHead, StatTile, type ReactNodeLike } from "@moss/module-web-sdk";
import type { BillsDue, StripFigures } from "./attention-model";
import { formatCents, monthLabel, weekdayDayLabel } from "./format";

export interface StripInput {
  month: string;
  currency: string;
  /** Null while a read is loading or after it failed. Tiles then show a dash. */
  income: { cents: number; deposits: number | null } | null;
  figures: StripFigures;
  bills: BillsDue | null;
  pastMonth: boolean;
  onOverspent: () => void;
  onBills: () => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function MonthStrip(props: StripInput): ReactNodeLike {
  const { figures, currency } = props;
  const money = (cents: number) => formatCents(cents, currency);
  const over = figures.overspentCount > 0;
  const bills = props.bills;
  return (
    <section className="fnm-block fnm-block--tight" aria-label="This month">
      <div className="fnm-block fnm-block--tiny">
        <Eyebrow tone="gold">This month</Eyebrow>
        <SectionHead title={monthLabel(props.month)} rule />
      </div>
      <div className="fnm-strip">
        <StatTile
          label="Income so far"
          value={props.income ? money(props.income.cents) : "–"}
          sub={
            props.income && props.income.deposits !== null
              ? plural(props.income.deposits, "deposit")
              : undefined
          }
        />
        <StatTile
          label="Spent"
          value={money(figures.spentCents)}
          sub={`of ${money(figures.assignedCents)} assigned`}
        />
        <StatTile
          label="Left to spend"
          value={money(figures.leftCents)}
          sub={`across ${plural(figures.leftCount, "category", "categories")}`}
        />
        <StatTile
          label="Bills due"
          value={bills ? money(bills.cents) : "–"}
          sub={
            bills
              ? props.pastMonth
                ? `${plural(bills.count, "bill")} unpaid`
                : `${plural(bills.count, "bill")}, ${
                    bills.pastDue > 0
                      ? `${bills.pastDue} past due`
                      : bills.next
                        ? `next ${weekdayDayLabel(bills.next)}`
                        : "none left"
                  }`
              : undefined
          }
          onClick={props.onBills}
        />
        <StatTile
          label="Overspent"
          value={over ? money(figures.overspentCents) : "None"}
          sub={
            over
              ? figures.overspentCount > 1
                ? `${figures.overspentCount} categories, ${figures.worstOverspent} most`
                : figures.worstOverspent
              : "0 categories"
          }
          warn={over}
          onClick={over ? props.onOverspent : undefined}
        />
      </div>
    </section>
  );
}
