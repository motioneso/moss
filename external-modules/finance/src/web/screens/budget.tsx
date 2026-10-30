import { CardPayments, type CardPaymentView } from "../card-payments";
import type { TargetFundingLine } from "../../domain/target-funding";
import { FLEX_POOL } from "../../domain/flex";
import { FlexBudgetPanel, type FlexBudgetView } from "../flex-budget";
import { BudgetTargets } from "../budget-targets";
import type { TargetProgress } from "../../domain/targets";
// external-modules/finance/src/web/screens/budget.tsx
//
// #3173: the Park Press Budget screen. One read, finance.budget.status, returns the
// month's derived state, the categories, the account balances and the reconciled
// "ready to assign" figure.
//
// Assigned amounts use the guarded host tool. Typed input is retained until persistence,
// and all totals continue to show the committed budget during review.
//
// Desktop and phone layouts both render; module CSS shows one and hides the other.
import {
  Badge,
  Button,
  DisclosureToggle,
  Eyebrow,
  Indicator,
  Masthead,
  Note,
  RowIndex,
  RowIndexItem,
  SectionHead,
  StatTile,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { useReadCooldown } from "../read-cooldown";
import { BudgetSetup } from "../budget-setup";
import { currentMonth, formatCents, monthLabel, parseAmountToCents, shiftMonth } from "../format";
import { navigate } from "../router";
import { announce, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";

interface BudgetCategory {
  id: string;
  name: string;
  archived?: boolean;
  tableGroup: string;
}

interface CategoryState {
  assignedCents: number;
  activityCents: number;
  availableCents: number;
}

interface BudgetAccount {
  accountId: string;
  name: string;
  balanceCents: number | null;
  isoCurrency: string;
  asOf: string | null;
  stale: boolean;
}

interface BudgetStatusResult extends Record<string, unknown> {
  month: string;
  cardPayments?: CardPaymentView[];
  cardChoices?: { accountId: string; name: string }[];
  cardStorageReady?: boolean;
  cardLedgerReviewRequired?: boolean;
  targets?: TargetProgress[];
  targetFunding?: TargetFundingLine[];
  targetFundingOverspent?: boolean;
  flex?: FlexBudgetView["flex"];
  flexChoices?: FlexBudgetView["flexChoices"];
  flexDetail?: FlexBudgetView["flexDetail"];
  currentMonth?: string;
  revision?: number;
  fingerprint?: string;
  isoCurrency?: string | null;
  setupRequired?: boolean;
  storageReady?: boolean;
  legacyMonthCount?: number;
  legacyDraft?: boolean;
  legacyMonths?: { month: string; totalCents: string }[];
  currencies?: string[];
  accountCurrencies?: string[];
  readyUnavailable?: string | null;
  pendingCount?: number;
  excludedAccountCount?: number;
  futureReservedCents?: number;
  state?: { categories: Record<string, CategoryState> };
  categories?: BudgetCategory[];
  accounts?: BudgetAccount[];
  hasBank?: boolean;
  hasBudget?: boolean;
  readyToAssignCents?: number | null;
  needsLookCount?: number;
}

const money = (cents: number, currency: string): string => formatCents(cents, currency);

// Display order. Income and Transfers are not envelopes.
const GROUPS = ["Flexible", "Fixed", "Non-monthly", "Bills", "Everyday", "Fun", "Savings"] as const;
const NOT_ENVELOPES: ReadonlySet<string> = new Set(["income", "transfers"]);
const ZERO: CategoryState = { assignedCents: 0, activityCents: 0, availableCents: 0 };

interface Line {
  currency: string;
  id: string;
  name: string;
  assigned: number;
  spent: number;
  available: number;
  carried: number | null;
  archived: boolean;
}

interface Group {
  name: string;
  lines: Line[];
}

function buildGroups(result: BudgetStatusResult): Group[] {
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

function AvailableCell(props: {
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

interface AssignProps {
  errors: Record<string, string>;
  drafts: Record<string, string>;
  disabled: boolean;
  onDraft: (id: string, value: string | null) => void;
  onAssign: (line: Line, cents: number) => void;
  onBadAmount: (line: Line) => void;
}
/** Typed input stays separate from committed totals until the host reports persistence. */
function AssignCell(props: { line: Line } & AssignProps): ReactNodeLike {
  const { line } = props;
  const draft = props.drafts[line.id];
  const finish = () => {
    if (draft === undefined || props.disabled || line.archived) return;
    const cents = parseAmountToCents(draft);
    if (cents === null) props.onBadAmount(line);
    else if (cents !== line.assigned) props.onAssign(line, cents);
    else props.onDraft(line.id, null);
  };
  const error = props.errors[line.id];
  return (
    <div className="fnm-assign">
      <input
        className="jds-input jds-input--sm fnm-assign__input"
        aria-label={`Assigned to ${line.name}`}
        aria-invalid={error ? "true" : undefined}
        inputMode="decimal"
        disabled={props.disabled || line.archived}
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
        onKeyDown={(event: { key: string; preventDefault: () => void }) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish();
          }
          if (event.key === "Escape") props.onDraft(line.id, null);
        }}
      />
      {draft !== undefined && parseAmountToCents(draft) !== line.assigned ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={props.disabled}
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
function groupAssigned(group: Group): string {
  const cents = group.lines.reduce((sum, line) => sum + BigInt(line.assigned), 0n);
  return cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)
    ? "Unavailable"
    : money(Number(cents), group.lines[0]!.currency);
}

function GroupTable(props: { group: Group; head: boolean } & AssignProps): ReactNodeLike {
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
            <tr key={line.id} data-overspent={line.available < 0 ? "true" : undefined}>
              <td>
                <div className="fnm-block fnm-block--tight">
                  <span>{line.name}</span>
                  <CarriedBadge currency={line.currency} cents={line.carried} />
                </div>
              </td>
              <td className="jds-table__num">
                <AssignCell line={line} {...props} />
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

function GroupRows(props: { group: Group } & AssignProps): ReactNodeLike {
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={props.group.name} rule />
      <RowIndex density="compact">
        {props.group.lines.map((line) => (
          <RowIndexItem
            key={line.id}
            title={line.name}
            excerpt={
              <div className="fnm-block fnm-block--tight">
                <CarriedBadge currency={line.currency} cents={line.carried} />
                <span>{money(line.spent, line.currency)} spent of</span>
                <AssignCell line={line} {...props} />
                <Meter line={line} />
              </div>
            }
            meta={<AvailableCell currency={line.currency} cents={line.available} labelled />}
          />
        ))}
      </RowIndex>
    </section>
  );
}

function asOfLabel(iso: string | null): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso ?? "");
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return "Sign-in expired";
  return `As of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) })}`;
}

function BalanceList(props: { accounts: BudgetAccount[] }): ReactNodeLike {
  return (
    <RowIndex variant="facts">
      {props.accounts.map((account) => (
        <RowIndexItem
          key={account.accountId}
          title={account.name}
          excerpt={account.asOf ? asOfLabel(account.asOf) : "No balance recorded for this period"}
          meta={
            account.stale ? (
              <div className="fnm-block fnm-block--tight fnm-end">
                <span>
                  {account.balanceCents === null
                    ? "No recorded balance"
                    : money(account.balanceCents, account.isoCurrency)}
                </span>
                <Indicator status="error" label={asOfLabel(account.asOf)} />
              </div>
            ) : account.balanceCents === null ? (
              "No recorded balance"
            ) : (
              money(account.balanceCents, account.isoCurrency)
            )
          }
        />
      ))}
    </RowIndex>
  );
}

function RailBlock(props: {
  eyebrow: string;
  title: string;
  children: ReactNodeLike;
}): ReactNodeLike {
  return (
    <section className="fnm-block fnm-block--tight">
      <div className="fnm-block fnm-block--tiny">
        <Eyebrow tone="gold">{props.eyebrow}</Eyebrow>
        <SectionHead title={props.title} rule />
      </div>
      {props.children}
    </section>
  );
}

function NeedsYou(props: { needsLook: number; overspent: number }): ReactNodeLike {
  const total = props.needsLook + props.overspent;
  if (total === 0) return null;
  const showOverspent = (): void => {
    document
      .querySelector("[data-overspent='true']")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <RailBlock eyebrow="Needs you" title={total === 1 ? "1 thing" : `${total} things`}>
      <div className="fnm-stat-pair">
        <StatTile
          label="Needs a look"
          value={String(props.needsLook)}
          onClick={() => navigate("/transactions")}
        />
        <StatTile label="Overspent" value={String(props.overspent)} warn onClick={showOverspent} />
      </div>
    </RailBlock>
  );
}

function CollapsedBalances(props: { accounts: BudgetAccount[]; currency: string }): ReactNodeLike {
  const [open, setOpen] = useState(false);
  const total = props.accounts.some((account) => account.balanceCents === null)
    ? null
    : props.accounts.reduce((sum, account) => sum + BigInt(account.balanceCents!), 0n);
  const stale = props.accounts.some((account) => account.stale);
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead
        title={
          <DisclosureToggle expanded={open} controls="fnm-balances" onClick={() => setOpen(!open)}>
            Budget accounts
          </DisclosureToggle>
        }
        meta={
          <span className="fnm-inline">
            {stale ? <Indicator status="error" label="Sign-in expired" /> : null}
            {total === null ||
            total > BigInt(Number.MAX_SAFE_INTEGER) ||
            total < BigInt(Number.MIN_SAFE_INTEGER)
              ? "Unavailable"
              : money(Number(total), props.currency)}
          </span>
        }
        rule
      />
      {open ? (
        <div id="fnm-balances">
          <BalanceList accounts={props.accounts} />
        </div>
      ) : null}
    </section>
  );
}

function Hero(props: {
  month: string;
  readyCents: number | null;
  currency: string | null;
  unavailable: boolean;
  setupRequired: boolean;
  onMonth: (delta: number) => void;
}): ReactNodeLike {
  return (
    <div className="fnm-hero">
      <Masthead
        tone="field"
        eyebrow={props.setupRequired ? "Your budget" : "Ready to assign"}
        title={
          props.setupRequired
            ? "Choose a currency"
            : props.readyCents === null
              ? props.unavailable
                ? "Unavailable"
                : "…"
              : money(props.readyCents, props.currency!)
        }
        aside={
          <div className="fnm-month-step">
            <Button
              variant="field"
              size="sm"
              aria-label={monthLabel(shiftMonth(props.month, -1))}
              onClick={() => props.onMonth(-1)}
            >
              ←
            </Button>
            <span>
              {monthLabel(props.month)}
              {props.currency ? ` · ${props.currency}` : ""}
            </span>
            <Button
              variant="field"
              size="sm"
              aria-label={monthLabel(shiftMonth(props.month, 1))}
              onClick={() => props.onMonth(1)}
            >
              →
            </Button>
          </div>
        }
      />
    </div>
  );
}

function BudgetBody(props: { result: BudgetStatusResult } & AssignProps): ReactNodeLike {
  const { result } = props;
  // No bank: Getting started. A bank with no budget rows shows the categories at
  // zero, so the first amounts can be typed here.
  const sendToStart = result.hasBank === false;
  useEffect(() => {
    if (sendToStart) navigate("/start");
  }, [sendToStart]);
  if (sendToStart) return null;

  const groups = buildGroups(result);
  const accounts = result.accounts ?? [];
  const overspent = groups.flatMap((group) => group.lines).filter((l) => l.available < 0).length;
  const needsLook = result.needsLookCount ?? 0;
  return (
    <div className="fnm-page">
      <main className="fnm-block">
        {result.readyUnavailable === "missing_history" ? (
          <Note variant="practical">
            Ready to assign is unavailable because a budget account has no recorded balance for this
            period. Today's balance is not used for past months.
          </Note>
        ) : result.readyUnavailable === "future_month" ? (
          <Note variant="practical">
            This is a future plan. Its assigned amounts reserve today's cash; ready to assign is
            shown in the current month.
          </Note>
        ) : null}
        {(result.futureReservedCents ?? 0) > 0 ? (
          <Note variant="practical">
            {money(result.futureReservedCents!, result.isoCurrency!)} is reserved for future
            assignments.
          </Note>
        ) : null}
        <p className="jds-hint">
          {result.isoCurrency} budget · Posted entries only
          {result.pendingCount ? ` · ${result.pendingCount} pending entries excluded` : ""}
          {result.excludedAccountCount
            ? ` · ${result.excludedAccountCount} other-currency or tracking accounts excluded`
            : ""}
          . Positive category balances carry forward.
          {result.cardPayments?.length
            ? " Card debt remains in account balances; Ready uses each enrolled card's payment reserve instead of subtracting its full debt."
            : ""}
        </p>
        <div className="fnm-phone-only">
          <NeedsYou needsLook={needsLook} overspent={overspent} />
        </div>
        {groups.map((group, index) => (
          <div key={group.name}>
            <div className="fnm-desktop-only">
              <GroupTable group={group} head={index === 0} {...props} />
            </div>
            <div className="fnm-phone-only">
              <GroupRows group={group} {...props} />
            </div>
          </div>
        ))}
        <div className="fnm-phone-only">
          <CollapsedBalances accounts={accounts} currency={result.isoCurrency!} />
        </div>
      </main>
      <aside className="fnm-rail fnm-desktop-only">
        <NeedsYou needsLook={needsLook} overspent={overspent} />
        <RailBlock eyebrow="Accounts" title="Balances">
          <BalanceList accounts={accounts} />
        </RailBlock>
      </aside>
    </div>
  );
}

export function BudgetScreen(props: { tools?: ExternalModuleToolsHandleV1 }): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth);
  const [draftState, setDraftState] = useState<{
    amounts: Record<string, string>;
    review: string | null;
  }>({ amounts: {}, review: null });
  const drafts = draftState.amounts;
  const cooldown = useReadCooldown();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const localMonthChosen = useRef(false);
  const saving = useRef(false);
  const generation = useRef(0);
  const status = useToolQuery<BudgetStatusResult>("finance.budget.status", { month });
  const result =
    status.status === "settled" && status.outcome.kind === "ok" ? status.outcome.result : null;
  const checkingFrom = useRef(status);
  const review =
    result?.fingerprint && result.revision !== undefined
      ? JSON.stringify([month, result.revision, result.fingerprint])
      : null;
  const hasDrafts = Object.keys(drafts).length > 0;
  const staleDrafts = hasDrafts && draftState.review !== review;
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [month]);
  useEffect(() => {
    if (!localMonthChosen.current && result?.currentMonth) {
      localMonthChosen.current = true;
      setMonth(result.currentMonth);
    }
    if (
      status.status === "settled" &&
      status.outcome.kind === "error" &&
      status.outcome.retryAfterSeconds
    )
      cooldown.wait(status.outcome.retryAfterSeconds);
    if (checking && status !== checkingFrom.current && status.status === "settled") {
      setChecking(false);
      if (result && review) {
        setUncertain(false);
        setErrors({});
        setDraftState((old) => ({
          ...old,
          review: Object.keys(old.amounts).length ? review : null
        }));
        setMessage("Saved records refreshed. Review your typed amounts before saving.");
      } else {
        setUncertain(true);
        setMessage(
          "Saved records could not be checked. Your typed amounts are kept. Check again before saving."
        );
      }
    }
  }, [status]);
  const onDraft = (id: string, value: string | null) => {
    setDraftState((old) => {
      const next = { ...old.amounts };
      if (value === null) delete next[id];
      else next[id] = value;
      return {
        amounts: next,
        review: Object.keys(next).length
          ? Object.keys(old.amounts).length
            ? old.review
            : review
          : null
      };
    });
    setErrors((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  };
  const onBadAmount = (line: Line) =>
    setErrors((old) => ({ ...old, [line.id]: "Enter an amount like 250 or 250.50." }));
  const onAssign = (line: Line, cents: number) => {
    if (
      !props.tools ||
      !result?.fingerprint ||
      result.revision === undefined ||
      saving.current ||
      checking ||
      uncertain ||
      staleDrafts
    )
      return;
    const epoch = generation.current;
    saving.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const outcome = await props.tools!.invoke(
          line.id === FLEX_POOL ? "finance.flex.assign" : "finance.budget.assign",
          {
            month,
            ...(line.id === FLEX_POOL ? {} : { categoryId: line.id }),
            amountCents: cents,
            previousCents: line.assigned,
            expectedRevision: result.revision!,
            expectedFingerprint: result.fingerprint!
          }
        );
        if (generation.current !== epoch) return;
        if (outcome.status === "succeeded" && outcome.result.status === "ok") {
          onDraft(line.id, null);
          announce("Assignment saved.");
          invalidateQueries();
        } else if (outcome.status === "cancelled") {
          setErrors((old) => ({ ...old, [line.id]: "Cancelled. Your typed amount is kept." }));
        } else if (outcome.status === "rejected" || outcome.status === "invalid_input") {
          setUncertain(true);
          setErrors((old) => ({
            ...old,
            [line.id]:
              "Not saved. The budget may have changed. Refresh and review your typed amount."
          }));
          invalidateQueries();
        } else {
          setUncertain(true);
          setMessage(
            "The save could not be confirmed. Check saved records before trying again. Your typed amount is kept."
          );
        }
      } catch {
        if (generation.current === epoch) {
          setUncertain(true);
          setMessage("The save could not be confirmed. Check saved records before trying again.");
        }
      } finally {
        saving.current = false;
        if (generation.current === epoch) setBusy(false);
      }
    })();
  };
  const refresh = () => {
    if (saving.current || checking || cooldown.cooling) return;
    checkingFrom.current = status;
    setChecking(true);
    invalidateQueries();
  };
  return (
    <section aria-label="Budget">
      <Hero
        month={month}
        currency={result?.isoCurrency ?? null}
        unavailable={Boolean(result?.readyUnavailable)}
        setupRequired={result?.setupRequired === true}
        readyCents={result?.readyToAssignCents ?? null}
        onMonth={(delta) => {
          if (busy || checking || uncertain || hasDrafts) {
            setMessage("Save or clear your typed amounts before changing months.");
            return;
          }
          localMonthChosen.current = true;
          setErrors({});
          setMonth(shiftMonth(month, delta));
        }}
      />
      <div className="fnm-pad">
        {!result?.setupRequired ? (
          <div className="fnm-spread">
            <p className="jds-hint">
              Edit Assigned, then press Enter or Save. Totals reflect saved amounts.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || checking || cooldown.cooling}
              onClick={refresh}
            >
              {checking ? "Refreshing…" : "Check saved records"}
            </Button>
            {hasDrafts ? (
              <Button
                variant="link"
                size="sm"
                disabled={busy || checking}
                onClick={() => {
                  if (saving.current) return;
                  setDraftState({ amounts: {}, review: null });
                  setErrors({});
                }}
              >
                Discard typed amounts
              </Button>
            ) : null}
          </div>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {staleDrafts && !uncertain ? (
          <Note variant="practical">
            Saved budget changed. Your typed amounts are kept. Check saved records and review them
            before saving.
          </Note>
        ) : null}
        {!props.tools && !result?.setupRequired ? (
          <Note variant="practical">Update Moss to enable reviewed budget changes.</Note>
        ) : null}
        {outcomeGate(
          status,
          (body) =>
            body.cardLedgerReviewRequired ? (
              <section className="fnm-block" aria-label="Card ledger needs review">
                <Note variant="practical">
                  Review the card ledger before budgeting. Payment reserves need complete linked
                  manual transfers in one currency. Repair unlinked transfer categories in
                  Transactions, then use Record transfer in Accounts for payment pairs. Ready to
                  assign is unavailable until the ledger is consistent.
                </Note>
                <Button variant="secondary" onClick={() => navigate("/transactions")}>
                  Review transactions
                </Button>
              </section>
            ) : body.setupRequired ? (
              <BudgetSetup
                tools={props.tools}
                storageReady={body.storageReady ?? false}
                legacyMonthCount={body.legacyMonthCount ?? 0}
                legacyMonths={body.legacyMonths}
                legacyDraft={body.legacyDraft}
                currencies={body.currencies ?? []}
                accountCurrencies={body.accountCurrencies ?? []}
              />
            ) : (
              <div className="fnm-block">
                {body.fingerprint && body.revision !== undefined && body.isoCurrency ? (
                  <BudgetTargets
                    month={month}
                    currency={body.isoCurrency}
                    revision={body.revision}
                    fingerprint={body.fingerprint}
                    categories={(body.categories ?? []).filter((c) => c.id !== FLEX_POOL)}
                    targets={body.targets ?? []}
                    disabled={busy || checking || uncertain || hasDrafts}
                    funding={{
                      currentMonth: body.currentMonth ?? "",
                      readyCents: body.readyToAssignCents ?? null,
                      lines: body.targetFunding ?? [],
                      overspent: body.targetFundingOverspent === true
                    }}
                    onUncertain={() => setUncertain(true)}
                    tools={props.tools}
                  />
                ) : null}
                {body.isoCurrency &&
                body.revision !== undefined &&
                body.fingerprint &&
                body.currentMonth &&
                body.state ? (
                  <FlexBudgetPanel
                    disabled={busy || checking || uncertain || hasDrafts}
                    tools={props.tools}
                    data={{
                      month,
                      currentMonth: body.currentMonth,
                      isoCurrency: body.isoCurrency,
                      revision: body.revision,
                      fingerprint: body.fingerprint,
                      flex: body.flex ?? null,
                      flexChoices: body.flexChoices ?? [],
                      flexDetail: body.flexDetail ?? [],
                      state: body.state
                    }}
                  />
                ) : null}
                {body.isoCurrency && body.currentMonth && body.cardStorageReady ? (
                  <CardPayments
                    tools={props.tools}
                    disabled={busy || checking || uncertain || hasDrafts}
                    data={{
                      month,
                      currentMonth: body.currentMonth,
                      isoCurrency: body.isoCurrency,
                      cardPayments: body.cardPayments ?? [],
                      cardChoices: body.cardChoices ?? []
                    }}
                  />
                ) : null}
                <BudgetBody
                  result={body}
                  drafts={drafts}
                  disabled={busy || checking || uncertain || staleDrafts || !props.tools}
                  errors={errors}
                  onDraft={onDraft}
                  onAssign={onAssign}
                  onBadAmount={onBadAmount}
                />
              </div>
            ),
          { loadingLabel: "Loading budget" }
        )}
      </div>
    </section>
  );
}
