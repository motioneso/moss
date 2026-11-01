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
  Button,
  DisclosureToggle,
  Eyebrow,
  Indicator,
  Masthead,
  Note,
  PeriodStepper,
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
import { FLEX_POOL } from "../../domain/flex";
import { BudgetSetup } from "../budget-setup";
import type { BudgetAccount, BudgetStatusResult } from "../budget-status";
import {
  buildGroups,
  GroupRows,
  GroupTable,
  money,
  type AssignProps,
  type Layout,
  type Line
} from "../budget-table";
import { BudgetTargets } from "../budget-targets";
import { CardPayments } from "../card-payments";
import { CategoryDetail } from "../category-detail";
import { FlexBudgetPanel } from "../flex-budget";
import {
  centsToAmountInput,
  currentMonth,
  monthLabel,
  parseAmountToCents,
  shiftMonth
} from "../format";
import { useReadCooldown } from "../read-cooldown";
import { navigate } from "../router";
import { announce, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";

type Figures = Record<string, readonly [assigned: number, spent: number, available: number]>;

function figuresOf(result: BudgetStatusResult): Figures {
  const figures: Figures = {};
  for (const group of buildGroups(result))
    for (const line of group.lines) figures[line.id] = [line.assigned, line.spent, line.available];
  return figures;
}

/** A saved assignment waiting for the read that shows it. */
interface Landing {
  /** The revision the save was checked against. */
  from: number;
  review: string;
  id: string;
  cents: number;
  figures: Figures;
}

/**
 * True when the fresh read differs from the one the save was checked against by that save alone.
 * Every budget write adds exactly one to the revision, so one step means no other write landed.
 * Unchanged spending rules out a transaction change in between.
 */
function onlyOwnSave(landing: Landing, fresh: BudgetStatusResult): boolean {
  if (fresh.revision !== landing.from + 1) return false;
  const after = figuresOf(fresh);
  const ids = Object.keys(after);
  if (ids.length !== Object.keys(landing.figures).length) return false;
  return ids.every((id) => {
    const was = landing.figures[id];
    const now = after[id]!;
    if (!was) return false;
    if (id === landing.id) return now[0] === landing.cents && now[1] === was[1];
    return now[0] === was[0] && now[1] === was[1] && now[2] === was[2];
  });
}

/** The Assigned field for a line in one layout, found by data attribute so any id is safe. */
function assignField(layout: Layout, id: string): HTMLElement | null {
  const fields = document.querySelectorAll<HTMLInputElement>(`input[data-fnm-assign="${layout}"]`);
  return [...fields].find((field) => field.dataset.fnmLine === id) ?? null;
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

/** Scrolls to the first overspent row in the layout on screen, and moves focus to it. */
function showOverspent(): void {
  const rows = document.querySelectorAll<HTMLElement>("[data-overspent='true']");
  const row = [...rows].find((candidate) => candidate.getClientRects().length > 0);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  const target =
    row.querySelector<HTMLElement>("button.jds-table__rowlink, input:not(:disabled)") ?? row;
  if (target === row) row.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function NeedsYou(props: { needsLook: number; overspent: number }): ReactNodeLike {
  const total = props.needsLook + props.overspent;
  if (total === 0) return null;
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
        wrap
        title={
          <DisclosureToggle
            expanded={open}
            controls="fnm-balances"
            className="fnm-disclosure-head"
            onClick={() => setOpen(!open)}
          >
            Budget accounts
            <span className="fnm-disclosure-marker" aria-hidden="true" />
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
          props.setupRequired ? undefined : (
            <PeriodStepper
              label={monthLabel(props.month)}
              previousLabel={monthLabel(shiftMonth(props.month, -1))}
              nextLabel={monthLabel(shiftMonth(props.month, 1))}
              onPrevious={() => props.onMonth(-1)}
              onNext={() => props.onMonth(1)}
            />
          )
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
      <section className="fnm-block" aria-label="Categories" data-fnm-lines>
        {result.readyUnavailable === "missing_history" ? (
          <Note variant="practical">
            A budget account has no recorded balance for this month, so Ready to assign is
            unavailable.
          </Note>
        ) : result.readyUnavailable === "future_month" ? (
          <Note variant="practical">Ready to assign shows in the current month.</Note>
        ) : null}
        {(result.futureReservedCents ?? 0) > 0 ? (
          <Note variant="practical">
            {money(result.futureReservedCents!, result.isoCurrency!)} is reserved for future
            assignments.
          </Note>
        ) : null}
        {result.pendingCount || result.excludedAccountCount ? (
          <p className="jds-hint">
            {[
              result.pendingCount ? `${result.pendingCount} pending not counted yet` : null,
              result.excludedAccountCount
                ? `${result.excludedAccountCount} tracking or other-currency accounts left out`
                : null
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
        <div className="fnm-phone-only">
          <NeedsYou needsLook={needsLook} overspent={overspent} />
        </div>
        {groups.map((group, index) => (
          <div key={group.name}>
            <div className="fnm-desktop-only">
              <GroupTable group={group} head={index === 0} {...props} />
            </div>
            <div className="fnm-phone-only">
              <GroupRows group={group} head={index === 0} {...props} />
            </div>
          </div>
        ))}
        <div className="fnm-phone-only">
          <CollapsedBalances accounts={accounts} currency={result.isoCurrency!} />
        </div>
      </section>
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
  const [savingId, setSavingId] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; layout: Layout } | null>(null);
  const localMonthChosen = useRef(false);
  const saving = useRef(false);
  // Lines whose Enter or Save arrived during another save. Each saves once the read shows the
  // save before it, and only when that read holds no change from elsewhere.
  const queue = useRef<string[]>([]);
  const landing = useRef<Landing | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
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
    const saved = landing.current;
    if (saved && status.status === "settled") {
      landing.current = null;
      saving.current = false;
      const own = result !== null && review !== null && onlyOwnSave(saved, result);
      // Typed amounts were reviewed against the figures this screen just changed itself.
      if (own)
        setDraftState((old) =>
          Object.keys(old.amounts).length && old.review === saved.review ? { ...old, review } : old
        );
      const next = own ? nextQueued(result) : null;
      if (next) startSave(next.line, next.cents, result!);
      else {
        queue.current = [];
        setBusy(false);
        setSavingId(null);
      }
    }
    if (
      detail &&
      result &&
      !buildGroups(result).some((group) =>
        group.lines.some((line) => line.id === detail.id && !line.archived)
      )
    )
      setDetail(null);
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
  const nextQueued = (fresh: BudgetStatusResult): { line: Line; cents: number } | null => {
    const lines = buildGroups(fresh).flatMap((group) => group.lines);
    while (queue.current.length) {
      const id = queue.current.shift()!;
      const line = lines.find((candidate) => candidate.id === id && !candidate.archived);
      const draft = drafts[id];
      const cents = draft === undefined ? null : parseAmountToCents(draft);
      if (line && cents !== null && cents !== line.assigned) return { line, cents };
    }
    return null;
  };
  // The save stays open until the read that shows it lands, so the next save checks against it.
  const startSave = (line: Line, cents: number, base: BudgetStatusResult) => {
    const epoch = generation.current;
    let landed = false;
    saving.current = true;
    setBusy(true);
    setSavingId(line.id);
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
            expectedRevision: base.revision!,
            expectedFingerprint: base.fingerprint!
          }
        );
        if (generation.current !== epoch) return;
        if (outcome.status === "succeeded" && outcome.result.status === "ok") {
          onDraft(line.id, null);
          announce("Assignment saved.");
          landing.current = {
            from: base.revision!,
            review: JSON.stringify([month, base.revision, base.fingerprint]),
            id: line.id,
            cents,
            figures: figuresOf(base)
          };
          landed = true;
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
        if (!landed) {
          queue.current = [];
          saving.current = false;
          if (generation.current === epoch) {
            setBusy(false);
            setSavingId(null);
          }
        }
      }
    })();
  };
  const onAssign = (line: Line, cents: number) => {
    if (
      !props.tools ||
      !result?.fingerprint ||
      result.revision === undefined ||
      checking ||
      uncertain ||
      staleDrafts
    )
      return;
    if (saving.current) {
      if (!queue.current.includes(line.id)) queue.current.push(line.id);
      return;
    }
    startSave(line, cents, result);
  };
  const refresh = () => {
    if (saving.current || checking || cooldown.cooling) return;
    checkingFrom.current = status;
    setChecking(true);
    invalidateQueries();
  };
  const assignLocked = checking || uncertain || staleDrafts || !props.tools;
  const categoryDetail = (body: BudgetStatusResult): ReactNodeLike => {
    if (!detail) return null;
    const lines = buildGroups(body)
      .flatMap((group) => group.lines)
      .filter((line) => !line.archived);
    const line = lines.find((candidate) => candidate.id === detail.id);
    if (!line) return null;
    return (
      <CategoryDetail
        key={line.id}
        line={line}
        month={month}
        result={body}
        others={lines.filter((other) => other.id !== line.id)}
        fillLocked={assignLocked || savingId === line.id}
        locked={busy || checking || uncertain || hasDrafts}
        lockedReason={
          uncertain
            ? "Check saved records first."
            : hasDrafts
              ? "Save or clear typed amounts first."
              : null
        }
        tools={props.tools}
        returnFocusRef={returnTo}
        onQuickAmount={(cents) => {
          onDraft(line.id, centsToAmountInput(cents));
          returnTo.current = assignField(detail.layout, line.id) ?? returnTo.current;
          setDetail(null);
        }}
        onUncertain={() => setUncertain(true)}
        onClose={() => setDetail(null)}
      />
    );
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
          setDetail(null);
          setMonth(shiftMonth(month, delta));
        }}
      />
      <div className="fnm-pad">
        {!result?.setupRequired && (uncertain || staleDrafts || checking || hasDrafts) ? (
          <div className="fnm-chips">
            {uncertain || staleDrafts || checking ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || checking || cooldown.cooling}
                onClick={refresh}
              >
                {checking ? "Refreshing…" : "Check saved records"}
              </Button>
            ) : null}
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
                  Review the card ledger before budgeting. Ready to assign is unavailable until the
                  ledger is consistent.
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
                <BudgetBody
                  result={body}
                  drafts={drafts}
                  disabled={assignLocked}
                  savingId={savingId}
                  openId={detail?.id ?? null}
                  errors={errors}
                  onDraft={onDraft}
                  onAssign={onAssign}
                  onBadAmount={onBadAmount}
                  onOpen={(line, layout, opener) => {
                    returnTo.current = opener;
                    setDetail({ id: line.id, layout });
                  }}
                />
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
                {categoryDetail(body)}
              </div>
            ),
          { loadingLabel: "Loading budget", errorMessage: "Your budget didn't load." }
        )}
      </div>
    </section>
  );
}
