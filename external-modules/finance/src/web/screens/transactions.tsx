// external-modules/finance/src/web/screens/transactions.tsx
//
// #3176: the Park Press Transactions screen. One read, finance.transactions.query,
// returns the month's rows, the categories, the accounts and the Needs a look count.
// Legacy pending/KV/rule reviews use finance.review-apply jobs. Captured confirmation and bulk
// categorization and split edits await reviewed host-tool persistence.
//
// One toolbar holds the view, the month, search, Filters and Export. The ledger renders a table
// and a phone row list; module CSS shows one and hides the other.
import {
  Button,
  Menu,
  Note,
  PeriodStepper,
  Segmented,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { runWrite, type RunOutcome } from "../api";
import { chunkReviewRows } from "../assign";
import { currentMonth, monthLabel, shiftMonth } from "../format";
import { announce, EmptyState, outcomeGate } from "../states";
import { invalidateQueries, invalidateToolQueries, useToolQuery } from "../store";
import { downloadTransactionsCsv, transactionsCsv, initialRegisterScope } from "../register";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filterInput,
  REGISTER_FILTERS_ID,
  RegisterFilterChips,
  RegisterFilterPanel
} from "../register-filters";
import { SplitEditor } from "../split-editor";
import {
  TransactionDetails,
  captureTransactionDetails,
  type CapturedTransactionDetails
} from "../transaction-details";
import { TransferCorrectionDialog } from "../transfer-correction-dialog";
import { TransactionConfirm } from "../transaction-confirm";
import { HistoryExportDialog } from "../history-export-dialog";
import { TransactionBulkBar, BULK_LIMIT, bulkEligible } from "../transaction-bulk";
import { saveSingleCategory } from "../transaction-single";
import { navigate } from "../router";
import {
  detailsKey,
  isLook,
  LedgerRows,
  LedgerTable,
  rowFocusTarget,
  type RowContext,
  type Tx,
  type TxAccount,
  type TxCategory
} from "../transaction-rows";

interface TxResult extends Record<string, unknown> {
  month: string;
  transactions?: Tx[];
  categories?: TxCategory[];
  accounts?: TxAccount[];
  needsLookCount?: number;
  totalCount?: number;
  supportsSplits?: boolean;
  supportsBulk?: boolean;
  supportsConfirm?: boolean;
  supportsNotes?: boolean;
}

type Filter = "all" | "look";

const REFETCH_DELAY_MS = 2000;
const SEARCH_DELAY_MS = 300;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

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

const splitEligible = (tx: Tx): boolean => !tx.transferId && !tx.shared && !tx.pending;

function TransactionsBody(props: {
  onDetails: (tx: Tx, details: CapturedTransactionDetails) => void;
  result: TxResult;
  filter: Filter;
  searching: boolean;
  confirmed: ReadonlySet<string>;
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
  onChange: (tx: Tx, categoryId: string) => Promise<boolean>;
  working: string | null;
  onWork: (id: string | null) => void;
  onTransfer?: (id: string) => void;
  selected: ReadonlySet<string>;
  selectionLocked: boolean;
  onSelect?: (tx: Tx) => void;
  onSelectRows?: (rows: Tx[], checked: boolean) => void;
}): ReactNodeLike {
  const { result, filter, confirmed } = props;
  const accounts = result.accounts ?? [];
  const categories = result.categories ?? [];
  const live = categories.filter((category) => !category.archived);
  const all = result.transactions ?? [];
  // Rows already confirmed here drop out of the Needs a look filter at once.
  const rows = filter === "look" ? all.filter((tx) => !confirmed.has(tx.id)) : all;
  const editable = rows.filter(bulkEligible);
  const ctx: RowContext = {
    categories: live,
    categoryName: (tx) =>
      categories.find((category) => category.id === tx.categoryId)?.name ?? "Uncategorized",
    accountName: (tx) => accounts.find((account) => account.accountId === tx.accountId)?.name ?? "",
    confirmed,
    working: props.working,
    onWork: props.onWork,
    allUncleared:
      rows.length > 0 &&
      rows.every((tx) => tx.source === "manual" && !tx.cleared && !tx.reconciledAt),
    onDetails: (tx) =>
      props.onDetails(
        tx,
        captureTransactionDetails({
          row: tx,
          accountName: ctx.accountName(tx),
          categoryName: ctx.categoryName(tx),
          categories
        })
      ),
    onTransfer: props.onTransfer,
    onConfirm: props.onConfirm,
    onChange: props.onChange,
    selected: props.selected,
    selectionLocked: props.selectionLocked,
    onSelect: props.onSelect,
    selectAll: props.onSelectRows
      ? {
          checked: editable.length > 0 && editable.every((tx) => props.selected.has(tx.id)),
          disabled: props.selectionLocked || editable.length === 0,
          onChange: (checked) => props.onSelectRows!(editable, checked)
        }
      : undefined
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
    return (
      <EmptyState
        title="No transactions this month"
        action={
          <>
            <Button variant="primary" size="sm" onClick={() => navigate("/accounts?add=entry")}>
              Add transaction
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate("/accounts?add=import")}>
              Import CSV
            </Button>
          </>
        }
      />
    );
  }
  return (
    <>
      <div className="fnm-desktop-only">
        <LedgerTable rows={rows} ctx={ctx} />
      </div>
      <div className="fnm-phone-only">
        <LedgerRows rows={rows} ctx={ctx} />
      </div>
    </>
  );
}

export function TransactionsScreen(
  props: { tools?: ExternalModuleToolsHandleV1 } = {}
): ReactNodeLike {
  const [initial] = useState(() =>
    initialRegisterScope(typeof window === "undefined" ? "" : window.location.search)
  );
  const [ownOnly, setOwnOnly] = useState(initial.ownOnly);
  const [month, setMonth] = useState(() => initial.month ?? currentMonth());
  const [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(() => ({
    ...EMPTY_FILTERS,
    ...(initial.accountId ? { accountId: initial.accountId } : {})
  }));
  const singleBusy = useRef(false);
  const [singleUncertain, setSingleUncertain] = useState(false);
  const [checkingSingle, setCheckingSingle] = useState(false);
  const singleReadSnapshot = useRef<unknown>(null);
  // The one row whose category picker is open, and the last category save with its Undo.
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    undo?: { id: string; categoryId: string; month: string };
  } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [details, setDetails] = useState<CapturedTransactionDetails | null>(null);
  const [detailsTx, setDetailsTx] = useState<Tx | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersButton = useRef<HTMLButtonElement | null>(null);
  const focusFilters = () => filtersButton.current?.focus();
  const [editing, setEditing] = useState<Tx | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  // The review returns focus to the row it was opened from, even after following a link inside it.
  const transferOrigin = useRef<string | null>(null);
  const [transferReturnFocus] = useState(() => ({
    get current(): HTMLElement | null {
      return rowFocusTarget("data-finance-transfer-id", transferOrigin.current ?? "");
    }
  }));
  const openTransfer = (id: string) => {
    transferOrigin.current = id;
    setTransferId(id);
  };
  // The split editor opens as the details view closes, so it has no live control to return to.
  const splitOrigin = useRef<Tx | null>(null);
  useEffect(() => {
    if (editing) {
      splitOrigin.current = editing;
      return;
    }
    const row = splitOrigin.current;
    splitOrigin.current = null;
    if (row) rowFocusTarget("data-finance-details", detailsKey(row))?.focus();
  }, [editing]);
  const [selected, setSelected] = useState<ReadonlyMap<string, Tx>>(new Map());
  const [selectionLocked, setSelectionLocked] = useState(false);
  const [supportsBulk, setSupportsBulk] = useState(false);
  const [supportsConfirm, setSupportsConfirm] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const toggleSelection = (tx: Tx): void => {
    if (selectionLocked || !bulkEligible(tx)) return;
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(tx.id)) next.delete(tx.id);
      else if (next.size < BULK_LIMIT) next.set(tx.id, { ...tx });
      return next;
    });
  };
  const selectRows = (rows: readonly Tx[], checked: boolean): void => {
    if (selectionLocked) return;
    setSelected((previous) => {
      const next = new Map(previous);
      for (const tx of rows) {
        if (!checked) next.delete(tx.id);
        else if (bulkEligible(tx) && !next.has(tx.id) && next.size < BULK_LIMIT)
          next.set(tx.id, { ...tx });
      }
      return next;
    });
  };
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
    ...(ownOnly ? { ownOnly: true } : {}),
    ...(search ? { search } : {}),
    ...(filter === "look" ? { needsLookOnly: true } : {})
  });
  const result =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;
  useEffect(() => setRetrying(false), [query]);
  useEffect(() => {
    if (checkingSingle && query !== singleReadSnapshot.current && query.status === "settled") {
      setCheckingSingle(false);
      if (result !== null) setSingleUncertain(false);
    }
  }, [query]);
  useEffect(() => {
    if (result) {
      setFilterOptions({ accounts: result.accounts ?? [], categories: result.categories ?? [] });
      setSupportsBulk(result.supportsBulk === true);
      setSupportsConfirm(result.supportsConfirm === true);
    }
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

  const categoryLabel = (id: string | null): string =>
    filterOptions.categories.find((c) => c.id === id)?.name ?? "Uncategorized";

  // Saves at once. The notice names the row and category and offers Undo for a change.
  const saveOne = async (tx: Tx, categoryId: string, confirmOnly: boolean): Promise<boolean> => {
    if (!props.tools || !tx.writeRevision || singleBusy.current || singleUncertain) return false;
    singleBusy.current = true;
    setNotice(null);
    setWorking(null);
    try {
      const outcome = await saveSingleCategory(
        props.tools,
        { id: tx.id, writeRevision: tx.writeRevision },
        categoryId,
        confirmOnly
      );
      if (outcome === "saved") {
        const label = categoryLabel(categoryId);
        const text = confirmOnly
          ? `Confirmed ${tx.name} as ${label}.`
          : `${tx.name} moved to ${label}.`;
        announce(text);
        setConfirmed((previous) => new Set([...previous, tx.id]));
        releaseOnRead.current = [...releaseOnRead.current, tx.id];
        readArmed.current = true;
        invalidateQueries();
        setNotice({
          text,
          undo:
            !confirmOnly && tx.categoryId
              ? { id: tx.id, categoryId: tx.categoryId, month: tx.date.slice(0, 7) }
              : undefined
        });
        return true;
      }
      if (outcome === "cancelled") {
        announce("Cancelled. Nothing was saved.");
      } else if (outcome === "refused") {
        setNotice({
          text: `Moss could not save ${tx.name}. Check that the category is still available.`
        });
      } else {
        setSingleUncertain(true);
        setNotice({
          text:
            outcome === "stale"
              ? `${tx.name} changed since this page loaded. Nothing was saved.`
              : `Saving ${tx.name} could not be confirmed.`
        });
      }
      return false;
    } finally {
      singleBusy.current = false;
    }
  };

  const undoChange = async (): Promise<void> => {
    const undo = notice?.undo;
    if (!undo || !props.tools || undoing) return;
    setUndoing(true);
    // A lookup by id gives the current revision even when the row has left the loaded list
    // (filter, search, paging) or the list has not refreshed since the save.
    let row: Tx | undefined;
    try {
      const lookup = await props.tools.invoke("finance.transactions.query", {
        month: undo.month,
        transactionId: undo.id
      });
      if (lookup.status === "succeeded") {
        row = ((lookup.result as unknown as TxResult).transactions ?? []).find(
          (tx) => tx.id === undo.id
        );
      }
    } catch {
      row = undefined;
    }
    if (!row?.writeRevision) {
      setUndoing(false);
      setNotice({ text: "Could not undo. The transaction could not be found.", undo });
      return;
    }
    const outcome = await saveSingleCategory(
      props.tools,
      { id: row.id, writeRevision: row.writeRevision },
      undo.categoryId,
      false
    );
    setUndoing(false);
    invalidateQueries();
    if (outcome === "saved") {
      const text = `${row.name} is back in ${categoryLabel(undo.categoryId)}.`;
      announce(text);
      setNotice({ text });
    } else {
      setNotice({
        text: `Could not undo the change to ${row.name}. It may have changed since.`
      });
    }
  };

  const confirmOne = (tx: Tx, categoryId: string, makeRule: boolean): void => {
    const unchanged = tx.categoryId === categoryId;
    if (
      !makeRule &&
      props.tools &&
      bulkEligible(tx) &&
      categoryId !== "transfers" &&
      (unchanged ? supportsConfirm : supportsBulk)
    ) {
      void saveOne(tx, categoryId, unchanged);
      return;
    }
    setWorking(null);
    void send([tx], [categoryId], makeRule, "Confirmed.");
  };

  const changeOne = (tx: Tx, categoryId: string): Promise<boolean> => {
    if (supportsBulk && props.tools && bulkEligible(tx) && categoryId !== "transfers") {
      return saveOne(tx, categoryId, false);
    }
    return send([tx], [categoryId], false, "Category changed.").then((saved) => {
      release([tx.id]);
      return saved;
    });
  };

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

  // No count until the register loads, so a failed load never claims zero.
  const lookLabel = result ? `Needs a look (${lookCount})` : "Needs a look";

  const loaded = result?.transactions?.length ?? 0;
  const total = result?.totalCount ?? loaded;
  const activeFilters = activeFilterCount(filters);
  const canSplit =
    detailsTx !== null && result?.supportsSplits === true && splitEligible(detailsTx);

  return (
    <section aria-label="Transactions" className="fnm-block fnm-block--tight">
      <div className="fnm-spread">
        <div className="fnm-chips">
          <Segmented
            ariaLabel="Filter transactions"
            value={filter}
            onChange={(value: Filter) => setFilter(value)}
            options={[
              { value: "all", label: "All" },
              { value: "look", label: lookLabel }
            ]}
          />
          {supportsConfirm ? (
            <TransactionConfirm
              rows={visibleLook.filter(bulkEligible)}
              categories={filterOptions.categories}
              tools={props.tools}
              readVersion={result}
              readSnapshot={query}
              readFailed={query.status === "settled" && query.outcome.kind !== "ok"}
              onReload={() => invalidateToolQueries("finance.transactions.query")}
              onSaved={(ids) => {
                setConfirmed((previous) => new Set([...previous, ...ids]));
                releaseOnRead.current = [...releaseOnRead.current, ...ids];
                readArmed.current = true;
                invalidateQueries();
              }}
            />
          ) : visibleLook.length > 0 ? (
            <Button variant="secondary" onClick={confirmAll}>
              Confirm all {visibleLook.length}
            </Button>
          ) : null}
        </div>
        <div className="fnm-chips">
          <PeriodStepper
            label={monthLabel(month)}
            previousLabel={monthLabel(shiftMonth(month, -1))}
            nextLabel={monthLabel(shiftMonth(month, 1))}
            onPrevious={() => setMonth(shiftMonth(month, -1))}
            onNext={() => setMonth(shiftMonth(month, 1))}
          />
          <input
            className="jds-input fnm-search"
            type="search"
            placeholder="Search payees or notes"
            aria-label="Search payees or notes"
            value={draft}
            onChange={(event: { target: { value: string } }) => setDraft(event.target.value)}
          />
          <Button
            ref={filtersButton}
            variant="secondary"
            active={filtersOpen}
            aria-expanded={filtersOpen}
            aria-controls={filtersOpen ? REGISTER_FILTERS_ID : undefined}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            {activeFilters ? `Filters · ${activeFilters}` : "Filters"}
          </Button>
          <Menu
            triggerVariant="button"
            triggerContent="Export"
            triggerLabel="Export transactions"
            items={[
              { id: "loaded", label: "Loaded rows", disabled: !loaded },
              { id: "history", label: "Full history…" }
            ]}
            onSelect={(id: string) => {
              if (id === "history") {
                setExporting(true);
                return;
              }
              if (!result?.transactions?.length) return;
              downloadTransactionsCsv(
                transactionsCsv(
                  result.transactions,
                  (tx) =>
                    result.accounts?.find((a) => a.accountId === tx.accountId)?.name ??
                    tx.accountId,
                  (tx) =>
                    result.categories?.find((c) => c.id === tx.categoryId)?.name ?? "Uncategorized"
                ),
                month
              );
              announce("Exported the loaded rows.");
            }}
          />
        </div>
      </div>
      {filtersOpen ? (
        <RegisterFilterPanel
          value={filters}
          onChange={setFilters}
          accounts={filterOptions.accounts}
          categories={filterOptions.categories}
          returnFocus={focusFilters}
        />
      ) : null}
      <RegisterFilterChips
        value={filtersOpen ? EMPTY_FILTERS : filters}
        onChange={setFilters}
        accounts={filterOptions.accounts}
        categories={filterOptions.categories}
        ownOnly={ownOnly}
        onIncludeShared={() => setOwnOnly(false)}
        returnFocus={focusFilters}
      />
      {singleUncertain ? (
        <div className="fnm-chips" role="status">
          <p>Check saved records before reviewing another category change.</p>
          <Button
            variant="secondary"
            disabled={checkingSingle}
            onClick={() => {
              singleReadSnapshot.current = query;
              setCheckingSingle(true);
              invalidateQueries();
            }}
          >
            {checkingSingle ? "Checking saved records…" : "Check saved records"}
          </Button>
        </div>
      ) : null}
      {notice ? (
        <Note variant="practical">
          <div className="fnm-look">
            <span role="status">{notice.text}</span>
            <div className="fnm-chips">
              {notice.undo ? (
                <Button variant="link" disabled={undoing} onClick={() => void undoChange()}>
                  {undoing ? "Undoing…" : "Undo"}
                </Button>
              ) : null}
              <Button variant="link" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </Note>
      ) : null}
      <TransactionDetails
        captured={details}
        onClose={() => {
          setDetails(null);
          setDetailsTx(null);
        }}
        tools={props.tools}
        supportsNotes={result?.supportsNotes}
        onSplit={
          canSplit
            ? () => {
                setEditing(detailsTx);
                setDetails(null);
                setDetailsTx(null);
              }
            : undefined
        }
      />
      {outcomeGate(
        query,
        (data) => (
          <TransactionsBody
            onDetails={(tx, captured) => {
              setDetailsTx({ ...tx });
              setDetails(captured);
            }}
            result={data}
            filter={filter}
            searching={search !== "" || activeFilters > 0}
            confirmed={confirmed}
            onConfirm={confirmOne}
            onChange={changeOne}
            working={working}
            onWork={setWorking}
            onTransfer={props.tools ? openTransfer : undefined}
            selected={new Set(selected.keys())}
            selectionLocked={selectionLocked}
            onSelect={result?.supportsBulk && props.tools ? toggleSelection : undefined}
            onSelectRows={result?.supportsBulk && props.tools ? selectRows : undefined}
          />
        ),
        {
          loadingLabel: "Loading transactions",
          errorMessage:
            "We couldn't load your transactions. Your filters are kept; check your connection or try again.",
          errorAction: (
            <Button
              variant="secondary"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                invalidateToolQueries("finance.transactions.query");
              }}
            >
              {retrying ? "Retrying register…" : "Retry register"}
            </Button>
          )
        }
      )}
      {result ? (
        <div className={loaded < total ? "fnm-chips" : "fnm-visually-hidden"}>
          <span role="status">
            {pages >= MAX_PAGES && loaded < total
              ? `Showing the first ${loaded.toLocaleString("en-US")}. Narrow the filters to see the rest.`
              : `${loaded.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} transactions`}
          </span>
          {loaded < total && pages < MAX_PAGES ? (
            <Button variant="secondary" onClick={() => setPages(pages + 1)}>
              Show more
            </Button>
          ) : null}
        </div>
      ) : null}
      {supportsBulk && props.tools ? (
        <TransactionBulkBar
          selected={[...selected.values()]}
          loaded={result?.transactions ?? []}
          categories={result?.categories ?? filterOptions.categories}
          tools={props.tools}
          onClear={() => setSelected(new Map())}
          onSaved={() => setSelected(new Map())}
          onLockChange={setSelectionLocked}
          onLoaded={() => selectRows(result?.transactions ?? [], true)}
        />
      ) : null}
      {exporting ? (
        <HistoryExportDialog
          accounts={filterOptions.accounts}
          onClose={() => setExporting(false)}
        />
      ) : null}
      {transferId && props.tools ? (
        <TransferCorrectionDialog
          key={transferId}
          transferId={transferId}
          tools={props.tools}
          returnFocusRef={transferReturnFocus}
          onClose={() => setTransferId(null)}
          onReview={setTransferId}
          onSaved={() => {
            setTransferId(null);
            invalidateQueries();
            announce("Transfer correction recorded. Original history is kept.");
          }}
        />
      ) : null}
      {editing ? (
        <SplitEditor
          transaction={editing}
          tools={props.tools}
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
