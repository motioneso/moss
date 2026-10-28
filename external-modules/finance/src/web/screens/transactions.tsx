// external-modules/finance/src/web/screens/transactions.tsx
//
// #3176: the Park Press Transactions screen. One read, finance.transactions.query,
// returns the month's rows, the categories, the accounts and the Needs a look count.
// Every write is a single finance.review-apply job: one row (optionally making a merchant
// rule) or Confirm all (the visible Needs a look rows, no rules).
//
// Desktop and phone layouts both render; module CSS shows one and hides the other.
import {
  Badge,
  Button,
  RowIndex,
  RowIndexItem,
  SectionHead,
  Segmented,
  Select,
  Switch,
  useEffect,
  useRef,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { runWrite, type RunOutcome } from "../api";
import { chunkReviewRows } from "../assign";
import { currentMonth, dayLabel, formatCents, monthLabel, shiftMonth } from "../format";
import { announce, EmptyState, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";
import { downloadTransactionsCsv, transactionsCsv } from "../register";
import { EMPTY_FILTERS, filterInput, RegisterFilterBar } from "../register-filters";
import { SplitEditor, type SplitTransaction } from "../split-editor";
import { splitsBalance } from "../../domain/splits";

interface TxCategory {
  id: string;
  name: string;
  archived?: boolean;
}

interface TxAccount {
  accountId: string;
  name: string;
  mask?: string | null;
}

interface Tx extends SplitTransaction {
  id: string;
  accountId: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  name: string;
  categoryId: string | null;
  reviewState?: "confirmed" | "needs_look";
  shared?: boolean;
  pending?: boolean;
  possibleDuplicate?: boolean;
}

interface TxResult extends Record<string, unknown> {
  month: string;
  transactions?: Tx[];
  categories?: TxCategory[];
  accounts?: TxAccount[];
  needsLookCount?: number;
  totalCount?: number;
  supportsSplits?: boolean;
}

type Filter = "all" | "look";

const REFETCH_DELAY_MS = 2000;
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

const isLook = (tx: Tx): boolean =>
  tx.shared !== true &&
  (tx.reviewState === "needs_look" || Boolean(tx.splits?.length && !splitsBalance(tx)));

/** True when the job was queued; false when the request failed and nothing will happen. */
function afterRun(outcome: RunOutcome, queuedMessage: string, onQueued: () => void): boolean {
  if (outcome.kind === "queued") {
    announce(queuedMessage);
    setTimeout(() => {
      onQueued();
      invalidateQueries();
    }, REFETCH_DELAY_MS);
    return true;
  }
  if (outcome.kind === "disabled") {
    announce("Finance is turned off on the server.");
  } else if (outcome.kind === "already-queued") {
    announce("Request failed: it was dropped. Try again.");
  } else {
    announce(`Request failed: ${outcome.message}`);
  }
  return false;
}

function Amount(props: { tx: Tx }): ReactNodeLike {
  const { tx } = props;
  // Money in is stored negative.
  if (tx.amountCents < 0) return <strong>+{formatCents(-tx.amountCents, tx.isoCurrency)}</strong>;
  return <span>{formatCents(tx.amountCents, tx.isoCurrency)}</span>;
}

function TransactionStatus(props: { tx: Tx }): ReactNodeLike {
  return (
    <div className="fnm-chips">
      {props.tx.pending ? <Badge tone="steel">Pending</Badge> : null}
      {props.tx.shared ? <Badge tone="steel">Household · read only</Badge> : null}
      {props.tx.possibleDuplicate ? <Badge tone="amber">Possible duplicate</Badge> : null}
      {props.tx.splits?.length && !splitsBalance(props.tx) ? (
        <Badge tone="amber">Check split total</Badge>
      ) : null}
    </div>
  );
}

// The category picker, Confirm button and merchant switch for one Needs a look row.
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
      <div className="fnm-inline">
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
        <Button
          size="sm"
          disabled={categoryId === ""}
          onClick={() => props.onConfirm(tx, categoryId, makeRule)}
        >
          Confirm
        </Button>
      </div>
      <Switch
        ariaLabel={`Always use this category for ${tx.name}`}
        label="Always for this merchant"
        checked={makeRule}
        onChange={setMakeRule}
      />
    </div>
  );
}

// The category picker for a row that is already confirmed. Picking another category saves it.
function ChangeCategory(props: {
  tx: Tx;
  categories: TxCategory[];
  onChange: (tx: Tx, categoryId: string) => Promise<boolean>;
}): ReactNodeLike {
  const { tx } = props;
  const [categoryId, setCategoryId] = useState(tx.categoryId ?? "");
  return (
    <Select
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

interface DayGroup {
  date: string;
  rows: Tx[];
}

function groupByDay(rows: Tx[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const tx of rows) {
    const last = groups.at(-1);
    if (last && last.date === tx.date) last.rows.push(tx);
    else groups.push({ date: tx.date, rows: [tx] });
  }
  return groups;
}

interface RowContext {
  categories: TxCategory[];
  categoryName: (tx: Tx) => string;
  accountName: (tx: Tx) => string;
  confirmed: ReadonlySet<string>;
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
  onChange: (tx: Tx, categoryId: string) => Promise<boolean>;
  onSplit: (tx: Tx) => void;
  supportsSplits: boolean;
}

function CategoryControls({
  tx,
  ctx,
  look
}: {
  tx: Tx;
  ctx: RowContext;
  look: boolean;
}): ReactNodeLike {
  return (
    <div className="fnm-category-controls">
      {tx.splits?.length ? (
        <span>
          {tx.splits.length} categories ·{" "}
          {tx.splits
            .map(
              (part) =>
                ctx.categories.find((c) => c.id === part.categoryId)?.name ?? "Archived category"
            )
            .join(", ")}
        </span>
      ) : tx.shared ? (
        ctx.categoryName(tx)
      ) : look ? (
        <LookControls tx={tx} categories={ctx.categories} onConfirm={ctx.onConfirm} />
      ) : (
        <ChangeCategory
          key={`${tx.id}:${tx.categoryId}`}
          tx={tx}
          categories={ctx.categories}
          onChange={ctx.onChange}
        />
      )}
      {ctx.supportsSplits && !tx.shared && !tx.pending ? (
        <Button
          variant="link"
          size="sm"
          aria-label={`${tx.splits?.length ? "Edit split for" : "Split"} ${tx.name}`}
          onClick={() => ctx.onSplit(tx)}
        >
          {tx.splits?.length ? "Edit split" : "Split"}
        </Button>
      ) : null}
    </div>
  );
}

function DayTable(props: { day: DayGroup; head: boolean; ctx: RowContext }): ReactNodeLike {
  const { day, ctx } = props;
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={dayLabel(day.date)} rule />
      <table className="jds-table fnm-fixed">
        <colgroup>
          <col className="fnm-col-payee" />
          <col className="fnm-col-category" />
          <col />
          <col className="fnm-col-amount" />
        </colgroup>
        {props.head ? (
          <thead>
            <tr>
              <th>Payee</th>
              <th>Category</th>
              <th>Account</th>
              <th className="jds-table__num">Amount</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {day.rows.map((tx) => {
            const look = isLook(tx) && !ctx.confirmed.has(tx.id);
            return (
              <tr key={tx.id}>
                <td>
                  <div className="fnm-block fnm-block--tight">
                    <span>{tx.name}</span>
                    <TransactionStatus tx={tx} />
                    {look && !tx.splits?.length ? (
                      <div>
                        <Badge tone="amber">Predicted</Badge>
                      </div>
                    ) : null}
                  </div>
                </td>
                <td>
                  <CategoryControls tx={tx} ctx={ctx} look={look} />
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
    </section>
  );
}

function DayRows(props: { day: DayGroup; ctx: RowContext }): ReactNodeLike {
  const { day, ctx } = props;
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={dayLabel(day.date)} rule />
      <RowIndex density="compact">
        {day.rows.map((tx) => {
          const look = isLook(tx) && !ctx.confirmed.has(tx.id);
          return (
            <RowIndexItem
              key={tx.id}
              title={
                <span className="fnm-block fnm-block--tight">
                  {tx.name}
                  <TransactionStatus tx={tx} />
                </span>
              }
              excerpt={
                <div className="fnm-block fnm-block--tight">
                  {look && !tx.splits?.length ? <Badge tone="amber">Predicted</Badge> : null}
                  <CategoryControls tx={tx} ctx={ctx} look={look} />
                  <span>{ctx.accountName(tx)}</span>
                </div>
              }
              meta={<Amount tx={tx} />}
            />
          );
        })}
      </RowIndex>
    </section>
  );
}

function TransactionsBody(props: {
  result: TxResult;
  filter: Filter;
  searching: boolean;
  confirmed: ReadonlySet<string>;
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
  onChange: (tx: Tx, categoryId: string) => Promise<boolean>;
  onSplit: (tx: Tx) => void;
}): ReactNodeLike {
  const { result, filter, confirmed } = props;
  const accounts = result.accounts ?? [];
  const categories = result.categories ?? [];
  const live = categories.filter((category) => !category.archived);
  const all = result.transactions ?? [];
  // Rows already confirmed here drop out of the Needs a look filter at once.
  const rows = filter === "look" ? all.filter((tx) => !confirmed.has(tx.id)) : all;
  const ctx: RowContext = {
    categories: live,
    categoryName: (tx) =>
      categories.find((category) => category.id === tx.categoryId)?.name ?? "Uncategorized",
    accountName: (tx) => accounts.find((account) => account.accountId === tx.accountId)?.name ?? "",
    confirmed,
    onConfirm: props.onConfirm,
    onChange: props.onChange,
    onSplit: props.onSplit,
    supportsSplits: result.supportsSplits === true
  };
  if (rows.length === 0) {
    if (filter === "look") {
      return (
        <EmptyState title="Nothing needs a look" body="No transactions in this view need review." />
      );
    }
    if (props.searching) {
      return <EmptyState title="No matches" body="No transaction in this month matches." />;
    }
    return <EmptyState title="Nothing yet" body="Transactions appear after the first sync." />;
  }
  const days = groupByDay(rows);
  return (
    <div className="fnm-block">
      <div className="fnm-desktop-only fnm-block">
        {days.map((day, index) => (
          <DayTable key={day.date} day={day} head={index === 0} ctx={ctx} />
        ))}
      </div>
      <div className="fnm-phone-only fnm-block">
        {days.map((day) => (
          <DayRows key={day.date} day={day} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

export function TransactionsScreen(): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [editing, setEditing] = useState<Tx | null>(null);
  const [filterOptions, setFilterOptions] = useState<{
    accounts: TxAccount[];
    categories: TxCategory[];
  }>({ accounts: [], categories: [] });
  // Rows confirmed here, hidden from Needs a look until the refetch catches up.
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  // How many pages of PAGE_SIZE rows to load; Show more adds one.
  const [pages, setPages] = useState(1);

  useEffect(() => setPages(1), [month, filter, search, filters]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const query = useToolQuery<TxResult>("finance.transactions.query", {
    month,
    limit: PAGE_SIZE * pages,
    ...filterInput(filters),
    ...(search ? { search } : {}),
    ...(filter === "look" ? { needsLookOnly: true } : {})
  });
  const result =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;
  useEffect(() => {
    if (result)
      setFilterOptions({ accounts: result.accounts ?? [], categories: result.categories ?? [] });
  }, [result]);

  // Ids whose server answer should replace the optimistic mark once the next read lands.
  const releaseOnRead = useRef<string[]>([]);
  const readArmed = useRef(false);
  const release = (ids: readonly string[]): void =>
    setConfirmed((previous) => new Set([...previous].filter((id) => !ids.includes(id))));

  // After the post-save read lands, the server's review state wins over the optimistic mark.
  useEffect(() => {
    if (!readArmed.current || result === null) return;
    readArmed.current = false;
    const ids = releaseOnRead.current;
    releaseOnRead.current = [];
    release(ids);
  }, [query]);

  const send = (
    rows: Tx[],
    categoryIds: string[],
    createRule: boolean,
    message: string
  ): Promise<boolean> => {
    const ids = rows.map((row) => row.id);
    setConfirmed((previous) => new Set([...previous, ...ids]));
    // One command per batch that fits the host's size limit; the sender spaces them apart.
    const chunks = chunkReviewRows(
      rows.map((row, i) => ({
        transactionId: row.id,
        accountId: row.accountId,
        month,
        categoryId: categoryIds[i] as string
      })),
      createRule
    );
    return Promise.all(
      chunks.map((chunk) =>
        runWrite("finance.review-apply", "finance.review-apply", { ...chunk }).then((outcome) => {
          const chunkIds = chunk.transactionIds;
          const queued = afterRun(outcome, message, () => {
            releaseOnRead.current = [...releaseOnRead.current, ...chunkIds];
            readArmed.current = true;
          });
          // A command that never ran will not change anything, so show its rows again.
          if (!queued) release(chunkIds);
          return queued;
        })
      )
    ).then((all) => all.every(Boolean));
  };

  const confirmOne = (tx: Tx, categoryId: string, makeRule: boolean): void => {
    void send([tx], [categoryId], makeRule, "Confirmed.");
  };

  // Changing an already-confirmed row only rewrites its category; it is never hidden.
  const changeOne = (tx: Tx, categoryId: string): Promise<boolean> =>
    send([tx], [categoryId], false, "Category changed.").then((saved) => {
      // The row was never in Needs a look here, so take off the optimistic mark right away.
      release([tx.id]);
      return saved;
    });

  // Exactly the Needs a look rows on screen: the filter, the search and the month decide them.
  const visibleLook = (result?.transactions ?? []).filter(
    (tx) => isLook(tx) && tx.categoryId !== null && !tx.splits?.length && !confirmed.has(tx.id)
  );
  const confirmAll = (): void => {
    void send(
      visibleLook,
      visibleLook.map((tx) => tx.categoryId as string),
      false,
      `Confirmed ${visibleLook.length}.`
    );
  };

  // The server counts rows the viewer still sees as Needs a look; take off those confirmed here.
  const stillCounted = (result?.transactions ?? []).filter(
    (tx) => isLook(tx) && confirmed.has(tx.id)
  ).length;
  const lookCount = Math.max(0, (result?.needsLookCount ?? 0) - stillCounted);

  return (
    <section aria-label="Transactions" className="fnm-block">
      <div className="fnm-spread">
        <div className="fnm-chips">
          <Segmented
            ariaLabel="Filter transactions"
            value={filter}
            onChange={(value: Filter) => setFilter(value)}
            options={[
              { value: "all", label: "All" },
              { value: "look", label: `Needs a look (${lookCount})` }
            ]}
          />
          {visibleLook.length > 0 ? (
            <Button variant="secondary" onClick={confirmAll}>
              Confirm all {visibleLook.length}
            </Button>
          ) : null}
        </div>
        <div className="fnm-chips">
          <Button
            variant="field"
            size="sm"
            aria-label={monthLabel(shiftMonth(month, -1))}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ←
          </Button>
          <span>{monthLabel(month)}</span>
          <Button
            variant="field"
            size="sm"
            aria-label={monthLabel(shiftMonth(month, 1))}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            →
          </Button>
          <input
            className="jds-input fnm-search"
            placeholder="Search payees or notes"
            aria-label="Search payees or notes"
            value={draft}
            onChange={(event: { target: { value: string } }) => setDraft(event.target.value)}
          />
        </div>
      </div>
      <RegisterFilterBar
        value={filters}
        onChange={setFilters}
        accounts={filterOptions.accounts}
        categories={filterOptions.categories}
      />
      {filters.attention === "duplicates" ? (
        <p role="status">
          These entries share an account, date, amount, currency and payee. They may be separate
          purchases. Nothing has been removed.
        </p>
      ) : null}
      {result ? (
        <div className="fnm-spread">
          <span role="status">
            {result.transactions?.length ?? 0} of{" "}
            {result.totalCount ?? result.transactions?.length ?? 0} matching transactions loaded ·{" "}
            {monthLabel(month)}
          </span>
          <Button
            variant="secondary"
            disabled={!result.transactions?.length}
            onClick={() => {
              downloadTransactionsCsv(
                transactionsCsv(
                  result.transactions ?? [],
                  (tx) =>
                    result.accounts?.find((a) => a.accountId === tx.accountId)?.name ??
                    tx.accountId,
                  (tx) =>
                    result.categories?.find((c) => c.id === tx.categoryId)?.name ?? "Uncategorized"
                ),
                month
              );
              announce(
                "Exported loaded transactions. The file includes only the rows loaded in this view."
              );
            }}
          >
            Export loaded rows
          </Button>
        </div>
      ) : null}
      {outcomeGate(
        query,
        (data) => (
          <TransactionsBody
            result={data}
            filter={filter}
            searching={search !== "" || Object.values(filters).some(Boolean)}
            confirmed={confirmed}
            onConfirm={confirmOne}
            onChange={changeOne}
            onSplit={setEditing}
          />
        ),
        { loadingLabel: "Loading transactions" }
      )}
      {result !== null &&
      (result.totalCount ?? 0) > (result.transactions ?? []).length &&
      pages < MAX_PAGES ? (
        <div>
          <Button variant="secondary" onClick={() => setPages(pages + 1)}>
            Show more
          </Button>
        </div>
      ) : null}
      {result &&
      pages >= MAX_PAGES &&
      (result.totalCount ?? 0) > (result.transactions?.length ?? 0) ? (
        <p role="status">
          This view shows at most 2,000 rows. Narrow the filters to see and export the remaining
          transactions.
        </p>
      ) : null}
      {editing ? (
        <SplitEditor
          transaction={editing}
          categories={filterOptions.categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidateQueries();
            announce("Split saved.");
          }}
        />
      ) : null}
    </section>
  );
}
