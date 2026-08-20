// external-modules/finance/src/web/screens/feed.tsx
// FIN-02 (#1147) Task 11: the transaction feed — the module's single screen.
// One read (finance.transactions.query is the one-call feed: transactions +
// categories + accounts); every write rides a manual-run queue (D4): inline
// recategorize → finance.categorize-apply with the four identifier ids only
// (D6), "Sync now" → finance.sync-run, "Finish connecting" →
// finance.connect-poll with a caller-driven 30s re-poll (D2). Queue runs are
// fire-and-forget 202s, so mutations pair an optimistic local override with a
// delayed invalidate-and-refetch; the connect loop's stop signal is the
// refetched account set changing (no read tool exposes link sessions — the
// worker marks them completed/abandoned server-side).
//
// FIN-04 (#1149) Task 5: household layer. The same query now returns other
// members' shared accounts/transactions tagged { shared, ownerUserId }; the
// web side resolves owner ids to display names against the host directory
// (fail closed — no directory, no shared rows) and every OWN account pill
// gets a Share/Shared toggle riding the finance.share-apply queue with
// metadata-only params ({ accountId, shared }, D6). Totals and the connect
// fingerprint stay own-accounts-only: household balances are context, not
// the user's money, and a member sharing/unsharing must never stop a
// connect poll.
import {
  Badge,
  Button,
  Card,
  Select,
  useEffect,
  useRef,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { fetchUserDirectory, runQueue, type RunOutcome } from "../api";
import { currentMonth, dayLabel, formatCents, monthLabel, shiftMonth } from "../format";
import { resolveSharedOwners, type DirectoryUser } from "../household";
import { announce, EmptyState, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";
import type { HostActions } from "../root";

interface FeedAccount {
  accountId: string;
  name: string;
  mask: string | null;
  balanceCents: number;
  isoCurrency: string;
  // Own accounts only — shared views deliberately omit Plaid plumbing (#1149).
  itemStatus?: string;
  updatedAt: string;
  sharedToHousehold?: boolean;
  shared?: boolean;
  ownerUserId?: string;
}

// After resolveSharedOwners: surviving shared entries carry their owner's
// display name; own entries pass through without one.
type ResolvedAccount = FeedAccount & { ownerName?: string };
type ResolvedTransaction = FeedTransaction & { ownerName?: string };

interface FeedCategory {
  id: string;
  name: string;
  archived?: boolean;
}

interface FeedTransaction {
  id: string;
  accountId: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  name: string;
  merchant: string | null;
  categoryId: string | null;
  pending: boolean;
  shared?: boolean;
  ownerUserId?: string;
}

interface FeedResult extends Record<string, unknown> {
  month: string;
  transactions?: FeedTransaction[];
  categories?: FeedCategory[];
  accounts?: FeedAccount[];
}

const REFETCH_DELAY_MS = 2000;
const POLL_INTERVAL_MS = 30_000;
// 10 rounds ≈ 5 minutes; the worker abandons link sessions at 30 min, so a
// stuck loop parks with guidance well before that.
const POLL_MAX_ROUNDS = 10;

function afterRun(outcome: RunOutcome, queuedMessage: string): void {
  if (outcome.kind === "queued" || outcome.kind === "already-queued") {
    announce(queuedMessage);
    setTimeout(() => invalidateQueries(), REFETCH_DELAY_MS);
  } else if (outcome.kind === "disabled") {
    announce("Finance is turned off on the server.");
  } else {
    announce(`Request failed: ${outcome.message}`);
  }
}

const STATUS_BADGE: Record<string, { label: string; tone: "forest" | "amber" }> = {
  connected: { label: "Connected", tone: "forest" },
  "reauth-required": { label: "Needs re-auth", tone: "amber" },
  error: { label: "Connection error", tone: "amber" }
};

function AccountPill(props: {
  account: ResolvedAccount;
  // Own accounts only: effective shared state (optimistic override applied)
  // and the toggle handler. Shared (foreign) pills render neither.
  sharedNow?: boolean;
  onToggleShare?: (account: ResolvedAccount) => void;
  key?: string;
}): ReactNodeLike {
  const account = props.account;
  const label = account.mask ? `${account.name} ··${account.mask}` : account.name;
  if (account.shared) {
    // A household member's account: owner attribution instead of a status
    // badge (shared views carry no itemStatus — Plaid plumbing stays with
    // the owner), and no Share toggle (only the owner may unshare, #1149).
    return (
      <Card flush>
        <span className="fnm-pill">
          <span>{label}</span>
          <span className="fnm-amount">
            {formatCents(account.balanceCents, account.isoCurrency)}
          </span>
          <Badge outline>{account.ownerName ?? "Household member"}</Badge>
        </span>
      </Card>
    );
  }
  const badge = STATUS_BADGE[account.itemStatus ?? "error"] ?? STATUS_BADGE.error;
  return (
    <Card flush>
      <span className="fnm-pill">
        <span>{label}</span>
        <span className="fnm-amount">{formatCents(account.balanceCents, account.isoCurrency)}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {props.onToggleShare ? (
          <Button
            variant="quiet"
            size="sm"
            aria-pressed={props.sharedNow === true}
            onClick={() => props.onToggleShare?.(account)}
          >
            {props.sharedNow ? "Shared" : "Share"}
          </Button>
        ) : null}
      </span>
    </Card>
  );
}

function TransactionRow(props: {
  record: ResolvedTransaction;
  month: string;
  categories: FeedCategory[];
  overrideCategoryId?: string;
  onRecategorize: (record: FeedTransaction, categoryId: string) => void;
  key?: string;
}): ReactNodeLike {
  const record = props.record;
  const categoryId = props.overrideCategoryId ?? record.categoryId;
  const category = props.categories.find((entry) => entry.id === categoryId);
  // Household rows are read-only (#1149): owner attribution plus a plain
  // category label — recategorize would enqueue against the VIEWER's chunks
  // and fail not_found; only the owner writes their records.
  if (record.shared) {
    return (
      <li className="fnm-txrow">
        <div className="fnm-txmain">
          <span>{record.name}</span>
          {record.merchant && record.merchant !== record.name ? (
            <span className="jds-eyebrow">{record.merchant}</span>
          ) : null}
        </div>
        <span className="fnm-txtags">
          {record.pending ? <Badge tone="amber">Pending</Badge> : null}
          <Badge outline>{record.ownerName ?? "Household member"}</Badge>
          <span className="jds-eyebrow">{category ? category.name : "Uncategorized"}</span>
        </span>
        <span className="fnm-amount">{formatCents(record.amountCents, record.isoCurrency)}</span>
      </li>
    );
  }
  return (
    <li className="fnm-txrow">
      <div className="fnm-txmain">
        <span>{record.name}</span>
        {record.merchant && record.merchant !== record.name ? (
          <span className="jds-eyebrow">{record.merchant}</span>
        ) : null}
      </div>
      <span className="fnm-txtags">
        {record.pending ? <Badge tone="amber">Pending</Badge> : null}
        <label className="fnm-catpick">
          <span className="fnm-visually-hidden">{`Category for ${record.name}`}</span>
          <Select
            value={categoryId ?? ""}
            onChange={(event: { target: { value: string } }) => {
              if (event.target.value) props.onRecategorize(record, event.target.value);
            }}
          >
            <option value="" disabled>
              {category ? category.name : "Uncategorized"}
            </option>
            {props.categories.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </label>
      </span>
      <span className="fnm-amount">{formatCents(record.amountCents, record.isoCurrency)}</span>
    </li>
  );
}

function FeedBody(props: {
  // Post-resolution arrays (#1149): the screen resolves owner names before
  // rendering, so unattributable shared entries are already dropped here.
  accounts: ResolvedAccount[];
  transactions: ResolvedTransaction[];
  categories: FeedCategory[];
  month: string;
  hostActions: HostActions;
  overrides: Record<string, string>;
  onRecategorize: (record: FeedTransaction, categoryId: string) => void;
}): ReactNodeLike {
  const transactions = props.transactions;
  const accounts = props.accounts;
  const live = props.categories.filter((category) => !category.archived);
  if (accounts.length === 0) {
    return (
      <EmptyState
        title="Connect a bank"
        body="Finance syncs accounts and transactions once a bank is connected. Ask your assistant to connect one — it walks you through the secure Plaid link."
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              props.hostActions.openAssistant({ starterPrompt: "Connect my bank account" })
            }
          >
            Connect with your assistant
          </Button>
        }
      />
    );
  }
  if (transactions.length === 0) {
    return (
      <EmptyState
        title={`No transactions in ${monthLabel(props.month)}`}
        body="Nothing synced for this month and filter. Try another month, clear filters, or run a sync."
      />
    );
  }
  const byDay: Array<{ date: string; rows: ResolvedTransaction[] }> = [];
  for (const record of transactions) {
    const group = byDay.at(-1);
    if (group && group.date === record.date) group.rows.push(record);
    else byDay.push({ date: record.date, rows: [record] });
  }
  return (
    <div className="fnm-stack">
      {byDay.map((group) => (
        <section key={group.date} aria-label={dayLabel(group.date)}>
          <h3 className="jds-eyebrow">{dayLabel(group.date)}</h3>
          <Card flush>
            <ul className="fnm-feed">
              {group.rows.map((record) => (
                <TransactionRow
                  key={record.id}
                  record={record}
                  month={props.month}
                  categories={live}
                  overrideCategoryId={props.overrides[record.id]}
                  onRecategorize={props.onRecategorize}
                />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}

export function FeedScreen(props: { hostActions: HostActions }): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  // Optimistic categorize: applied over rows until the refetched feed carries
  // the job's result (stale overrides are harmless — same value).
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Connect re-poll loop: null = idle; a number = rounds completed so far.
  const [pollRound, setPollRound] = useState<number | null>(null);
  const pollBaseline = useRef<string | null>(null);
  // Optimistic share toggles (#1149), keyed by accountId — applied over the
  // server's sharedToHousehold until a refetch reflects the queued job.
  const [shareOverrides, setShareOverrides] = useState<Record<string, boolean>>({});
  // Owner directory for household attribution; null = not loaded / failed,
  // in which case resolveSharedOwners drops every shared entry (fail closed).
  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchUserDirectory().then((users) => {
      if (!cancelled) setDirectory(users);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const feed = useToolQuery<FeedResult>("finance.transactions.query", {
    month,
    limit: 200,
    ...(accountId ? { accountId } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(search ? { search } : {}),
    ...(pendingOnly ? { pendingOnly } : {})
  });
  const settled =
    feed.status === "settled" && feed.outcome.kind === "ok" ? feed.outcome.result : null;
  const resolvedAccounts: ResolvedAccount[] = resolveSharedOwners(
    settled?.accounts ?? [],
    directory
  );
  const resolvedTransactions: ResolvedTransaction[] = resolveSharedOwners(
    settled?.transactions ?? [],
    directory
  );
  const ownAccounts = resolvedAccounts.filter((account) => account.shared !== true);
  // Own accounts only: a household member sharing/unsharing mid-poll must
  // never read as "my connection finished" (#1149).
  const fingerprint = JSON.stringify(
    ownAccounts.map((account) => `${account.accountId}:${account.itemStatus}`)
  );

  // Drive the connect re-poll (D2: caller-driven, ~30s, bounded). Each round
  // enqueues finance.connect-poll and schedules a refetch; the effect below
  // watches the account fingerprint for the stop signal.
  useEffect(() => {
    if (pollRound === null) return;
    if (pollRound >= POLL_MAX_ROUNDS) {
      setPollRound(null);
      announce("Still pending — finish the bank login in the Plaid tab, then try again.");
      return;
    }
    let cancelled = false;
    void runQueue("finance.connect-poll", "finance.connect-poll-now").then((outcome) => {
      if (cancelled) return;
      if (outcome.kind === "disabled" || outcome.kind === "error") {
        setPollRound(null);
        announce(
          outcome.kind === "disabled"
            ? "Finance is turned off on the server."
            : `Connection check failed: ${outcome.message}`
        );
        return;
      }
      setTimeout(() => invalidateQueries(), REFETCH_DELAY_MS);
    });
    const timer = setTimeout(() => {
      setPollRound((round) => (round === null ? null : round + 1));
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollRound]);

  useEffect(() => {
    if (pollRound === null || pollBaseline.current === null) return;
    if (fingerprint !== pollBaseline.current) {
      setPollRound(null);
      pollBaseline.current = null;
      announce("Bank connection updated. Run a sync to pull transactions.");
    }
  }, [fingerprint, pollRound]);

  const recategorize = (record: FeedTransaction, nextCategoryId: string): void => {
    setOverrides((previous) => ({ ...previous, [record.id]: nextCategoryId }));
    // Metadata-only params (D6): the four identifier ids, nothing else. The
    // chunk month is the queried month — that's the key the feed read from.
    void runQueue("finance.categorize-apply", "finance.categorize-apply", {
      transactionId: record.id,
      accountId: record.accountId,
      month,
      categoryId: nextCategoryId
    }).then((outcome) => afterRun(outcome, "Category update queued."));
  };

  const toggleShare = (account: ResolvedAccount): void => {
    const next = !(shareOverrides[account.accountId] ?? account.sharedToHousehold === true);
    setShareOverrides((previous) => ({ ...previous, [account.accountId]: next }));
    // Metadata-only params (D6): accountId + the desired flag, nothing else.
    // The worker's share.apply job mirrors or wipes the account server-side.
    void runQueue("finance.share-apply", "finance.share-apply", {
      accountId: account.accountId,
      shared: next
    }).then((outcome) =>
      afterRun(outcome, next ? "Sharing with your household…" : "Stopping sharing…")
    );
  };

  // Totals stay own-accounts-only: household balances are context on the
  // pills, not part of the user's net position (#1149).
  const totalsByCurrency = new Map<string, number>();
  for (const account of ownAccounts) {
    totalsByCurrency.set(
      account.isoCurrency,
      (totalsByCurrency.get(account.isoCurrency) ?? 0) + account.balanceCents
    );
  }

  return (
    <section className="fnm-stack" aria-label="Transaction feed">
      <div className="fnm-row">
        <div className="fnm-chips" aria-label="Connected accounts">
          {resolvedAccounts.map((account) => (
            <AccountPill
              key={
                account.shared ? `${account.ownerUserId}:${account.accountId}` : account.accountId
              }
              account={account}
              sharedNow={
                account.shared
                  ? undefined
                  : (shareOverrides[account.accountId] ?? account.sharedToHousehold === true)
              }
              onToggleShare={account.shared ? undefined : toggleShare}
            />
          ))}
          {[...totalsByCurrency].map(([currency, cents]) => (
            <Badge key={currency} outline>
              <span className="fnm-amount">{`Total ${formatCents(cents, currency)}`}</span>
            </Badge>
          ))}
        </div>
        <div className="fnm-chips">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void runQueue("finance.sync-run", "finance.sync-run-now").then((outcome) =>
                afterRun(outcome, "Sync queued — balances refresh shortly.")
              );
            }}
          >
            Sync now
          </Button>
          <Button
            variant="quiet"
            size="sm"
            disabled={pollRound !== null}
            onClick={() => {
              pollBaseline.current = fingerprint;
              setPollRound(0);
              announce("Checking for finished bank connections…");
            }}
          >
            {pollRound !== null ? "Checking connection…" : "Finish connecting"}
          </Button>
        </div>
      </div>
      <div className="fnm-row">
        <div className="fnm-chips" role="group" aria-label="Month">
          <Button
            variant="quiet"
            size="sm"
            aria-label="Previous month"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ←
          </Button>
          <span className="jds-eyebrow">{monthLabel(month)}</span>
          <Button
            variant="quiet"
            size="sm"
            aria-label="Next month"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            →
          </Button>
        </div>
        <form
          className="fnm-chips"
          onSubmit={(event: { preventDefault: () => void }) => {
            event.preventDefault();
            setSearch(searchDraft.trim());
          }}
        >
          <input
            className="jds-input jds-input--sm"
            type="search"
            placeholder="Search payee"
            aria-label="Search transactions"
            value={searchDraft}
            onChange={(event: { target: { value: string } }) => setSearchDraft(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </form>
      </div>
      <div className="fnm-chips" aria-label="Filters">
        <Button
          variant={accountId === null ? "secondary" : "quiet"}
          size="sm"
          aria-pressed={accountId === null}
          onClick={() => setAccountId(null)}
        >
          All accounts
        </Button>
        {resolvedAccounts.map((account) => (
          <Button
            key={account.shared ? `${account.ownerUserId}:${account.accountId}` : account.accountId}
            variant={accountId === account.accountId ? "secondary" : "quiet"}
            size="sm"
            aria-pressed={accountId === account.accountId}
            onClick={() => setAccountId(accountId === account.accountId ? null : account.accountId)}
          >
            {account.mask ? `${account.name} ··${account.mask}` : account.name}
          </Button>
        ))}
        <label className="fnm-catpick">
          <span className="jds-eyebrow">Category</span>
          <Select
            value={categoryId ?? ""}
            onChange={(event: { target: { value: string } }) =>
              setCategoryId(event.target.value || null)
            }
          >
            <option value="">All</option>
            {(settled?.categories ?? [])
              .filter((category) => !category.archived)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </Select>
        </label>
        <Button
          variant={pendingOnly ? "secondary" : "quiet"}
          size="sm"
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly(!pendingOnly)}
        >
          Pending only
        </Button>
      </div>
      {outcomeGate(
        feed,
        (result) => (
          <FeedBody
            accounts={resolvedAccounts}
            transactions={resolvedTransactions}
            categories={result.categories ?? []}
            month={month}
            hostActions={props.hostActions}
            overrides={overrides}
            onRecategorize={recategorize}
          />
        ),
        { loadingLabel: "Loading transactions" }
      )}
    </section>
  );
}
