// external-modules/finance/src/web/budget-table.tsx
// The category table: desktop rows and phone rows, each with an Assigned field.
//
// Keyboard: Enter saves the typed amount and moves to the next category, Shift+Enter moves up,
// Escape reverts. Each layout keeps its own field order, so the hidden layout never takes focus.
import { Badge, Button, SectionHead, type ReactNodeLike } from "@moss/module-web-sdk";
import type { BudgetStatusResult, CategoryState } from "./budget-status";
import { formatCents, parseAmountToCents } from "./format";

export const money = (cents: number, currency: string): string => formatCents(cents, currency);

// Display order. Income and Transfers are not envelopes.
const GROUPS = ["Flexible", "Fixed", "Non-monthly", "Bills", "Everyday", "Fun", "Savings"] as const;
const NOT_ENVELOPES: ReadonlySet<string> = new Set(["income", "transfers"]);
export const ZERO: CategoryState = { assignedCents: 0, activityCents: 0, availableCents: 0 };

export interface Line {
  currency: string;
  id: string;
  name: string;
  assigned: number;
  spent: number;
  available: number;
  carried: number | null;
  archived: boolean;
}

export interface Group {
  name: string;
  lines: Line[];
}

export type Layout = "desktop" | "phone";

export function buildGroups(result: BudgetStatusResult): Group[] {
  const states = result.state?.categories ?? {};
  const categories = (result.categories ?? []).filter(
    (category) =>
      !NOT_ENVELOPES.has(category.id) &&
      (!category.archived ||
        Object.values(states[category.id] ?? ZERO).some((cents) => cents !== 0))
  );
  return GROUPS.map((name) => ({
    name,
    lines: categories
      .filter((category) => category.tableGroup === name)
      .map((category): Line => {
        const row = states[category.id] ?? ZERO;
        const carry =
          BigInt(row.availableCents) - BigInt(row.assignedCents) + BigInt(row.activityCents);
        return {
          id: category.id,
          currency: result.isoCurrency ?? "",
          name: category.name,
          assigned: row.assignedCents,
          spent: row.activityCents,
          available: row.availableCents,
          // available = carried + assigned - spent
          carried: carry > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(carry < 0n ? 0n : carry),
          archived: category.archived === true
        };
      })
  })).filter((group) => group.lines.length > 0);
}

function Meter(props: { line: Line }): ReactNodeLike {
  const { assigned, spent, available } = props.line;
  const used = assigned <= 0 ? (spent > 0 ? 1 : 0) : Math.min(1, spent / assigned);
  return (
    <div
      className={`jds-progress${available < 0 ? " jds-progress--amber" : ""}`}
      aria-hidden="true"
    >
      <div className="jds-progress__fill" style={{ width: `${Math.round(used * 100)}%` }} />
    </div>
  );
}

export function AvailableCell(props: {
  cents: number;
  currency: string;
  labelled?: boolean;
}): ReactNodeLike {
  if (props.cents < 0) return <Badge tone="red">{money(-props.cents, props.currency)} over</Badge>;
  return (
    <strong>
      {money(props.cents, props.currency)}
      {props.labelled ? " left" : ""}
    </strong>
  );
}

function CarriedBadge(props: { cents: number | null; currency: string }): ReactNodeLike {
  if (props.cents === null) return <Badge>Carry unavailable</Badge>;
  if (props.cents <= 0) return null;
  return (
    <div>
      <Badge>{money(props.cents, props.currency)} carried over</Badge>
    </div>
  );
}

export interface AssignProps {
  errors: Record<string, string>;
  drafts: Record<string, string>;
  /** Locks every field: a check is running, the saved state is uncertain, or drafts are stale. */
  disabled: boolean;
  /** The one line whose save is in flight. Other fields stay editable and queue behind it. */
  savingId: string | null;
  onDraft: (id: string, value: string | null) => void;
  onAssign: (line: Line, cents: number) => void;
  onBadAmount: (line: Line) => void;
  onOpen?: (line: Line, layout: Layout, opener: HTMLElement) => void;
  /** The line whose detail panel is open; its row carries the open-row edge. */
  openId?: string | null;
}

/** Moves focus to the next enabled Assigned field of the same layout, or stays put at the end. */
function moveFocus(from: HTMLInputElement, step: 1 | -1): void {
  const scope = from.closest("[data-fnm-lines]");
  if (!scope) return;
  const fields = [
    ...scope.querySelectorAll<HTMLInputElement>(
      `input[data-fnm-assign="${from.dataset.fnmAssign}"]`
    )
  ];
  for (
    let index = fields.indexOf(from) + step;
    index >= 0 && index < fields.length;
    index += step
  ) {
    const field = fields[index]!;
    if (!field.disabled) {
      field.focus();
      return;
    }
  }
}

/** Typed input stays separate from committed totals until the host reports persistence. */
function AssignCell(props: { line: Line; layout: Layout } & AssignProps): ReactNodeLike {
  const { line } = props;
  const draft = props.drafts[line.id];
  const locked = props.disabled || line.archived || props.savingId === line.id;
  // True when focus may leave: nothing typed, the same amount, or a save started or queued.
  const finish = (): boolean => {
    if (locked) return false;
    if (draft === undefined) return true;
    const cents = parseAmountToCents(draft);
    if (cents === null) {
      props.onBadAmount(line);
      return false;
    }
    if (cents !== line.assigned) props.onAssign(line, cents);
    else props.onDraft(line.id, null);
    return true;
  };
  const error = props.errors[line.id];
  return (
    <div className="fnm-assign">
      <input
        className="jds-input jds-input--sm fnm-assign__input"
        aria-label={`Assigned to ${line.name}`}
        aria-invalid={error ? "true" : undefined}
        data-fnm-assign={props.layout}
        data-fnm-line={line.id}
        inputMode="decimal"
        enterKeyHint="next"
        disabled={locked}
        value={draft ?? money(line.assigned, line.currency)}
        onFocus={(event: { currentTarget: { select: () => void } }) => {
          event.currentTarget.select();
        }}
        onBlur={() => {
          if (draft !== undefined && parseAmountToCents(draft) === line.assigned)
            props.onDraft(line.id, null);
        }}
        onChange={(event: { currentTarget: { value: string } }) =>
          props.onDraft(line.id, event.currentTarget.value)
        }
        onKeyDown={(event: {
          key: string;
          shiftKey?: boolean;
          preventDefault: () => void;
          currentTarget?: HTMLInputElement;
        }) => {
          if (event.key === "Enter") {
            event.preventDefault();
            const field = event.currentTarget;
            if (finish() && field) moveFocus(field, event.shiftKey ? -1 : 1);
          }
          if (event.key === "Escape") props.onDraft(line.id, null);
        }}
      />
      {draft !== undefined && parseAmountToCents(draft) !== line.assigned ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={locked}
          onClick={finish}
          aria-label={`Save assignment to ${line.name}`}
        >
          Save
        </Button>
      ) : null}
      {line.archived ? <Badge>Archived · history</Badge> : null}
      {error ? (
        <p role="alert" className="jds-hint fnm-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function LineName(props: { line: Line; layout: Layout } & AssignProps): ReactNodeLike {
  const { line, onOpen } = props;
  if (!onOpen || line.archived) return <span>{line.name}</span>;
  return (
    <button
      type="button"
      className="jds-table__rowlink"
      aria-haspopup="dialog"
      onClick={(event: { currentTarget: HTMLElement }) =>
        onOpen(line, props.layout, event.currentTarget)
      }
    >
      {line.name}
    </button>
  );
}

function groupAssigned(group: Group): string {
  const cents = group.lines.reduce((sum, line) => sum + BigInt(line.assigned), 0n);
  return cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)
    ? "Unavailable"
    : money(Number(cents), group.lines[0]!.currency);
}

export function GroupTable(props: { group: Group; head: boolean } & AssignProps): ReactNodeLike {
  const { group } = props;
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={group.name} meta={`${groupAssigned(group)} assigned`} rule />
      <table className="jds-table fnm-fixed">
        <colgroup>
          <col className="fnm-col-name" />
          <col />
          <col />
          <col />
        </colgroup>
        {props.head ? (
          <thead>
            <tr>
              <th>Category</th>
              <th className="jds-table__num">Assigned</th>
              <th className="jds-table__num">Spent</th>
              <th className="jds-table__num">Available</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {group.lines.map((line) => (
            <tr
              key={line.id}
              data-overspent={line.available < 0 ? "true" : undefined}
              aria-selected={props.openId === line.id ? "true" : undefined}
            >
              <td>
                <div className="fnm-block fnm-block--tight">
                  <LineName line={line} layout="desktop" {...props} />
                  <CarriedBadge currency={line.currency} cents={line.carried} />
                </div>
              </td>
              <td className="jds-table__num">
                <AssignCell line={line} layout="desktop" {...props} />
              </td>
              <td className="jds-table__num">
                <div className="fnm-cell-stack">
                  <span>{money(line.spent, line.currency)}</span>
                  <div className="fnm-cell-meter">
                    <Meter line={line} />
                  </div>
                </div>
              </td>
              <td className="jds-table__num">
                <AvailableCell currency={line.currency} cents={line.available} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Phone rows: name, meter and spending on the left; the Assigned field and what is left on the right. */
export function GroupRows(props: { group: Group; head: boolean } & AssignProps): ReactNodeLike {
  const { group } = props;
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={group.name} meta={`${groupAssigned(group)} assigned`} rule />
      <table className="jds-table fnm-fixed">
        <colgroup>
          <col />
          <col className="fnm-col-assign" />
        </colgroup>
        {props.head ? (
          <thead>
            <tr>
              <th>Category</th>
              <th className="jds-table__num">Assigned</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {group.lines.map((line) => (
            <tr
              key={line.id}
              data-overspent={line.available < 0 ? "true" : undefined}
              aria-selected={props.openId === line.id ? "true" : undefined}
            >
              <td>
                <div className="fnm-block fnm-block--tight">
                  <div>
                    <LineName line={line} layout="phone" {...props} />
                    <div className="jds-table__sub">{money(line.spent, line.currency)} spent</div>
                  </div>
                  <Meter line={line} />
                  <CarriedBadge currency={line.currency} cents={line.carried} />
                </div>
              </td>
              <td className="jds-table__num">
                <div className="fnm-block fnm-block--tight fnm-cell-end">
                  <AssignCell line={line} layout="phone" {...props} />
                  <AvailableCell currency={line.currency} cents={line.available} labelled />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
