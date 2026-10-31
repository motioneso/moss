// external-modules/finance/src/web/transaction-rows.tsx
//
// The Transactions ledger: one dense table on wide screens and a two-line row list on a phone.
// Rows that need nothing read as a ledger; review controls render only on rows that need a look.
// Module CSS shows one layout and hides the other.
import {
  Badge,
  Button,
  Checkbox,
  Select,
  Switch,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { formatCents, shortDayLabel } from "./format";
import { BULK_LIMIT, bulkEligible } from "./transaction-bulk";
import type { SplitTransaction } from "./split-editor";
import { splitsBalance } from "../domain/splits";
import type { TransactionRecord } from "../domain/records";

export interface TxCategory {
  id: string;
  name: string;
  archived?: boolean;
}

export interface TxAccount {
  accountId: string;
  name: string;
  mask?: string | null;
}

export interface Tx extends SplitTransaction {
  id: string;
  accountId: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  name: string;
  categoryId: string | null;
  reviewState?: "confirmed" | "needs_look";
  categorizedBy?: TransactionRecord["categorizedBy"];
  shared?: boolean;
  pending?: boolean;
  possibleDuplicate?: boolean;
  notes?: string;
  source?: "manual";
  transferId?: string;
  cleared?: boolean;
  reconciledAt?: string | null;
  writeRevision?: string;
}

export const isLook = (tx: Tx): boolean =>
  tx.shared !== true &&
  (tx.reviewState === "needs_look" || Boolean(tx.splits?.length && !splitsBalance(tx)));

export interface RowContext {
  categories: TxCategory[];
  categoryName: (tx: Tx) => string;
  accountName: (tx: Tx) => string;
  confirmed: ReadonlySet<string>;
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
  onChange: (tx: Tx, categoryId: string) => Promise<boolean>;
  onDetails: (tx: Tx) => void;
  onTransfer?: (id: string) => void;
  selected: ReadonlySet<string>;
  selectionLocked: boolean;
  onSelect?: (tx: Tx) => void;
  /** The header box that selects or clears every editable loaded row. */
  selectAll?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
}

function Amount(props: { tx: Tx }): ReactNodeLike {
  const { tx } = props;
  // Money in is stored negative.
  if (tx.amountCents < 0) return <strong>+{formatCents(-tx.amountCents, tx.isoCurrency)}</strong>;
  return <span>{formatCents(tx.amountCents, tx.isoCurrency)}</span>;
}

/** Only states that ask for attention. Cleared, reconciled and posted rows carry no badge. */
function RowBadges(props: { tx: Tx; look: boolean }): ReactNodeLike {
  const { tx } = props;
  const uncleared = tx.source === "manual" && !tx.cleared && !tx.reconciledAt;
  const unbalanced = Boolean(tx.splits?.length && !splitsBalance(tx));
  const review = props.look && !tx.splits?.length;
  if (!tx.pending && !uncleared && !tx.shared && !tx.possibleDuplicate && !unbalanced && !review) {
    return null;
  }
  return (
    <div className="fnm-chips fnm-row-badges">
      {review ? (
        <Badge tone="amber">{tx.categorizedBy === "user" ? "Review needed" : "Predicted"}</Badge>
      ) : null}
      {tx.pending ? <Badge tone="steel">Pending</Badge> : null}
      {uncleared ? <Badge tone="steel">Uncleared</Badge> : null}
      {tx.shared ? <Badge tone="steel">Household · read only</Badge> : null}
      {tx.possibleDuplicate ? <Badge tone="amber">Possible duplicate</Badge> : null}
      {unbalanced ? <Badge tone="amber">Check split total</Badge> : null}
    </div>
  );
}

// The category picker for one Needs a look row, then the merchant switch and Confirm in the
// order they are used.
function LookControls(props: {
  tx: Tx;
  categories: TxCategory[];
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
}): ReactNodeLike {
  const { tx } = props;
  const [categoryId, setCategoryId] = useState(tx.categoryId ?? "");
  const [makeRule, setMakeRule] = useState(false);
  return (
    <div className="fnm-block fnm-block--tight">
      <Select
        aria-label={`Category for ${tx.name}`}
        value={categoryId}
        onChange={(event: { target: { value: string } }) => setCategoryId(event.target.value)}
      >
        <option value="" disabled>
          Choose a category
        </option>
        {props.categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </Select>
      <div className="fnm-look">
        <Switch
          ariaLabel={`Always use this category for ${tx.name}`}
          label="Always for this merchant"
          checked={makeRule}
          onChange={setMakeRule}
        />
        <Button
          size="sm"
          disabled={categoryId === ""}
          onClick={() => props.onConfirm(tx, categoryId, makeRule)}
        >
          Confirm
        </Button>
      </div>
    </div>
  );
}

// The quiet category picker on a confirmed row. Eligible changes open a captured review.
function ChangeCategory(props: {
  tx: Tx;
  categories: TxCategory[];
  onChange: (tx: Tx, categoryId: string) => Promise<boolean>;
}): ReactNodeLike {
  const { tx } = props;
  const [categoryId, setCategoryId] = useState(tx.categoryId ?? "");
  useEffect(() => setCategoryId(tx.categoryId ?? ""), [tx.categoryId, tx.writeRevision]);
  return (
    <Select
      quiet
      aria-label={`Category for ${tx.name}`}
      value={categoryId}
      onChange={(event: { target: { value: string } }) => {
        const next = event.target.value;
        const before = categoryId;
        setCategoryId(next);
        // A save that never ran puts the old category back on screen.
        void props.onChange(tx, next).then((saved) => {
          if (!saved) setCategoryId(before);
        });
      }}
    >
      <option value="" disabled>
        Uncategorized
      </option>
      {props.categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
    </Select>
  );
}

function CategoryCell(props: { tx: Tx; ctx: RowContext; look: boolean }): ReactNodeLike {
  const { tx, ctx } = props;
  if (tx.transferId) {
    return (
      <div className="fnm-chips">
        <Badge>Linked transfer</Badge>
        {!tx.shared && ctx.onTransfer ? (
          <Button
            variant="link"
            size="sm"
            aria-label={`Review transfer for ${ctx.accountName(tx)} on ${tx.date}`}
            data-finance-transfer-id={tx.transferId}
            onClick={() => ctx.onTransfer!(tx.transferId!)}
          >
            Review transfer
          </Button>
        ) : null}
      </div>
    );
  }
  if (tx.splits?.length) {
    return (
      <span>
        Split ·{" "}
        {tx.splits
          .map(
            (part) =>
              ctx.categories.find((c) => c.id === part.categoryId)?.name ?? "Archived category"
          )
          .join(", ")}
      </span>
    );
  }
  if (tx.shared) return <span>{ctx.categoryName(tx)}</span>;
  if (props.look) {
    return <LookControls tx={tx} categories={ctx.categories} onConfirm={ctx.onConfirm} />;
  }
  return (
    <ChangeCategory
      key={`${tx.id}:${tx.categoryId}`}
      tx={tx}
      categories={ctx.categories}
      onChange={ctx.onChange}
    />
  );
}

function SelectBox(props: { tx: Tx; ctx: RowContext }): ReactNodeLike {
  const { tx, ctx } = props;
  return ctx.onSelect && bulkEligible(tx) ? (
    <Checkbox
      ariaLabel={`Select ${tx.name}`}
      checked={ctx.selected.has(tx.id)}
      disabled={
        ctx.selectionLocked || (!ctx.selected.has(tx.id) && ctx.selected.size >= BULK_LIMIT)
      }
      onChange={() => ctx.onSelect!(tx)}
    />
  ) : null;
}

function PayeeButton(props: { tx: Tx; ctx: RowContext }): ReactNodeLike {
  const { tx } = props;
  return (
    <button
      type="button"
      className="jds-table__rowlink"
      aria-label={`View transaction details for ${tx.name}`}
      data-finance-details={JSON.stringify([tx.id, tx.accountId, tx.shared === true])}
      onClick={() => props.ctx.onDetails(tx)}
    >
      {tx.name}
    </button>
  );
}

const lookFor = (tx: Tx, ctx: RowContext): boolean => isLook(tx) && !ctx.confirmed.has(tx.id);

/** Wide screens: date, payee, category, account and amount in one table. */
export function LedgerTable(props: { rows: Tx[]; ctx: RowContext }): ReactNodeLike {
  const { ctx } = props;
  const selectable = ctx.onSelect !== undefined;
  return (
    <table className="jds-table fnm-fixed">
      <colgroup>
        {selectable ? <col className="fnm-col-check" /> : null}
        <col className="fnm-col-date" />
        <col className="fnm-col-payee" />
        <col className="fnm-col-category" />
        <col />
        <col className="fnm-col-amount" />
      </colgroup>
      <thead>
        <tr>
          {selectable ? (
            <th>
              {ctx.selectAll ? (
                <Checkbox
                  ariaLabel="Select all editable rows"
                  checked={ctx.selectAll.checked}
                  disabled={ctx.selectAll.disabled}
                  onChange={ctx.selectAll.onChange}
                />
              ) : null}
            </th>
          ) : null}
          <th>Date</th>
          <th>Payee</th>
          <th>Category</th>
          <th>Account</th>
          <th className="jds-table__num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((tx) => {
          const look = lookFor(tx, ctx);
          return (
            <tr key={tx.id} aria-selected={ctx.selected.has(tx.id) ? "true" : undefined}>
              {selectable ? (
                <td>
                  <SelectBox tx={tx} ctx={ctx} />
                </td>
              ) : null}
              <td>{shortDayLabel(tx.date)}</td>
              <td>
                <PayeeButton tx={tx} ctx={ctx} />
                <RowBadges tx={tx} look={look} />
              </td>
              <td>
                <CategoryCell tx={tx} ctx={ctx} look={look} />
              </td>
              <td>{ctx.accountName(tx)}</td>
              <td className="jds-table__num">
                <Amount tx={tx} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Phone: payee and amount on one line; date, account and the category under them. */
export function LedgerRows(props: { rows: Tx[]; ctx: RowContext }): ReactNodeLike {
  const { ctx } = props;
  const selectable = ctx.onSelect !== undefined;
  return (
    <table className="jds-table fnm-fixed">
      <tbody>
        {props.rows.map((tx) => {
          const look = lookFor(tx, ctx);
          return (
            <tr key={tx.id} aria-selected={ctx.selected.has(tx.id) ? "true" : undefined}>
              <td>
                <div className={selectable ? "fnm-txline fnm-txline--check" : "fnm-txline"}>
                  {selectable ? (
                    <div className="fnm-txline__check">
                      <SelectBox tx={tx} ctx={ctx} />
                    </div>
                  ) : null}
                  <div className="fnm-txline__name">
                    <PayeeButton tx={tx} ctx={ctx} />
                  </div>
                  <div className="fnm-txline__amount jds-table__num">
                    <Amount tx={tx} />
                  </div>
                  <div className="fnm-txline__body">
                    <div className="jds-table__sub">
                      {shortDayLabel(tx.date)} · {ctx.accountName(tx)}
                    </div>
                    <RowBadges tx={tx} look={look} />
                    <CategoryCell tx={tx} ctx={ctx} look={look} />
                  </div>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
