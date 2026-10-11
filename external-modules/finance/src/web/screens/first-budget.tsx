// external-modules/finance/src/web/screens/first-budget.tsx
//
// #3180: the first-budget draft on Getting started. The numbers all come from the stored
// draft (finance.budget.draft.get); this screen only lays them out. Matches mockup
// 05-first-budget. A plan amount is typed in place and saved through finance.draft-set; chat
// changes land in the same record, so the screen re-reads it every few seconds while open.
// The header total is summed from the lines shown, typed-but-unconfirmed amounts included.
//
// After the first sync the screen asks the worker to build the draft (finance.draft-build),
// then re-reads until it appears. "Start this budget" is the only way to start a budget: it
// queues finance.draft-start and re-reads until the draft is marked started, then opens Budget.
import {
  Badge,
  Button,
  Indicator,
  Masthead,
  Note,
  RowIndex,
  RowIndexItem,
  SectionHead,
  useEffect,
  useRef,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { runWrite } from "../api";
import { confirmedPlans, PENDING_GIVE_UP_MS, showPending, type PendingPlans } from "../draft-edit";
import { centsToAmountInput, formatCents, monthLabel, parseAmountToCents } from "../format";
import { navigate } from "../router";
import { announce, LoadingState, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";
import type { HostActions } from "../root";

export interface DraftLineView {
  categoryKey: string;
  categoryName: string;
  basisMonthlyCents: number;
  planCents: number;
  dropped: boolean;
  changedByMoss: boolean;
  proposedCents: number;
}

export interface DraftBody {
  id: string;
  status: "open" | "started" | "discarded";
  basisFrom: string;
  basisTo: string;
  monthlyIncomeCents: number;
  totalCents: number;
  unplannedCents: number;
  groups: { name: string; lines: DraftLineView[] }[];
}

export interface DraftResult extends Record<string, unknown> {
  hasSynced?: boolean;
  hasBudget?: boolean;
  draft?: DraftBody | null;
}

const CURRENCY = "USD";
const money = (cents: number): string => formatCents(cents, CURRENCY);

/** "2026-07-01" to "2026-09-30" reads as "July to September" (or one month). */
export function basisLabel(basisFrom: string, basisTo: string): string {
  const from = monthLabel(basisFrom.slice(0, 7)).replace(/ \d{4}$/, "");
  const to = monthLabel(basisTo.slice(0, 7)).replace(/ \d{4}$/, "");
  return from === to ? from : `${from} to ${to}`;
}

/** Whole months between the first and last basis day, rounded up; under one reads as short history. */
export function isShortHistory(basisFrom: string, basisTo: string): boolean {
  return basisFrom.slice(0, 7) === basisTo.slice(0, 7);
}

function unplannedLede(draft: DraftBody): string {
  const span = `Planned from ${basisLabel(draft.basisFrom, draft.basisTo)}.`;
  const income = money(draft.monthlyIncomeCents);
  if (draft.unplannedCents < 0) {
    return `${span} The plan is ${money(-draft.unplannedCents)} over your ${income} monthly income.`;
  }
  return `${span} ${money(draft.unplannedCents)} of your ${income} monthly income is still unplanned.`;
}

interface EditProps {
  errors: Record<string, string>;
  onSave: (line: DraftLineView, cents: number) => void;
  onBadAmount: (line: DraftLineView) => void;
}

/** The typing box for a line's plan amount. Saves on Enter or blur. */
function PlanCell(props: { line: DraftLineView } & EditProps): ReactNodeLike {
  const { line, errors } = props;
  const [typed, setTyped] = useState<string | null>(null);
  const finish = (): void => {
    if (typed === null) return;
    const cents = parseAmountToCents(typed);
    setTyped(null);
    if (cents === null || cents < 0) props.onBadAmount(line);
    else if (cents !== line.planCents || line.dropped) props.onSave(line, cents);
  };
  const error = errors[line.categoryKey];
  return (
    <div className="fnm-assign">
      <input
        className="jds-input jds-input--sm fnm-assign__input"
        aria-label={`Plan for ${line.categoryName}`}
        aria-invalid={error ? "true" : undefined}
        inputMode="decimal"
        value={typed ?? (line.dropped ? "" : money(line.planCents))}
        placeholder={line.dropped ? "Not in budget" : undefined}
        onFocus={(event: { currentTarget: { select: () => void } }) => {
          setTyped(line.dropped ? "" : centsToAmountInput(line.planCents));
          event.currentTarget.select();
        }}
        onChange={(event: { currentTarget: { value: string } }) =>
          setTyped(event.currentTarget.value)
        }
        onBlur={finish}
        onKeyDown={(event: { key: string; currentTarget: { blur: () => void } }) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setTyped(null);
        }}
      />
      {error ? <Indicator status="error" label={error} /> : null}
    </div>
  );
}

function ChatChange(props: { line: DraftLineView }): ReactNodeLike {
  if (!props.line.changedByMoss) return null;
  return (
    <div>
      <Badge tone="forest">
        {props.line.dropped
          ? "Dropped in chat"
          : `Changed in chat, was ${money(props.line.proposedCents)}`}
      </Badge>
    </div>
  );
}

function DraftTable(
  props: { group: DraftBody["groups"][number]; head: boolean } & EditProps
): ReactNodeLike {
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={props.group.name} rule />
      <table className="jds-table fnm-fixed">
        <colgroup>
          <col className="fnm-col-name" />
          <col />
          <col />
        </colgroup>
        {props.head ? (
          <thead>
            <tr>
              <th>Category</th>
              <th className="jds-table__num">Monthly average</th>
              <th className="jds-table__num">Plan</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {props.group.lines.map((line) => (
            <tr key={line.categoryKey}>
              <td>
                <div className="fnm-block fnm-block--tight">
                  <span>{line.categoryName}</span>
                  <ChatChange line={line} />
                </div>
              </td>
              <td className="jds-table__num jds-hint">{money(line.basisMonthlyCents)}</td>
              <td className="jds-table__num">
                <PlanCell
                  line={line}
                  errors={props.errors}
                  onSave={props.onSave}
                  onBadAmount={props.onBadAmount}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DraftRows(props: { group: DraftBody["groups"][number] } & EditProps): ReactNodeLike {
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={props.group.name} rule />
      <RowIndex density="compact">
        {props.group.lines.map((line) => (
          <RowIndexItem
            key={line.categoryKey}
            title={line.categoryName}
            excerpt={
              <div className="fnm-block fnm-block--tight">
                <ChatChange line={line} />
                <span>Average {money(line.basisMonthlyCents)}</span>
              </div>
            }
            meta={
              <PlanCell
                line={line}
                errors={props.errors}
                onSave={props.onSave}
                onBadAmount={props.onBadAmount}
              />
            }
          />
        ))}
      </RowIndex>
    </section>
  );
}

export interface FirstBudgetViewProps {
  draft: DraftBody;
  hostActions: HostActions;
  starting: boolean;
  startError: string | null;
  onStart: () => void;
  errors: Record<string, string>;
  onSave: (line: DraftLineView, cents: number) => void;
  onBadAmount: (line: DraftLineView) => void;
}

export function FirstBudgetView(props: FirstBudgetViewProps): ReactNodeLike {
  const { draft } = props;
  return (
    <div className="fnm-block">
      <Masthead
        tone="field"
        eyebrow="Your first budget"
        title={`${money(draft.totalCents)} a month`}
        lede={unplannedLede(draft)}
        aside={
          <div className="fnm-block fnm-block--tight">
            <Button variant="field" onClick={props.onStart} disabled={props.starting}>
              {props.starting ? "Starting your budget" : "Start this budget"}
            </Button>
            {props.startError ? <Indicator status="error" label={props.startError} /> : null}
          </div>
        }
      />
      {isShortHistory(draft.basisFrom, draft.basisTo) ? (
        <Note variant="practical">
          There is less than a full month of history so far, so this draft is built from what
          exists.
        </Note>
      ) : null}
      <div>
        <Button
          variant="secondary"
          onClick={() =>
            props.hostActions.openAssistant({
              starterPrompt: "Help me set up my first budget."
            })
          }
        >
          Build my budget with Moss
        </Button>
      </div>
      {draft.groups.map((group, index) => (
        <div key={group.name}>
          <div className="fnm-desktop-only">
            <DraftTable
              group={group}
              head={index === 0}
              errors={props.errors}
              onSave={props.onSave}
              onBadAmount={props.onBadAmount}
            />
          </div>
          <div className="fnm-phone-only">
            <DraftRows
              group={group}
              errors={props.errors}
              onSave={props.onSave}
              onBadAmount={props.onBadAmount}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const POLL_MS = 3000;
/** While a draft is open the screen re-reads it this often, which also shows chat changes. */
const MAX_POLLS = 10;

/**
 * Reads the draft and drives it: builds one after the first sync, shows an open
 * one, and sends the user to Budget once a budget exists. `fallback` renders
 * before the first sync, when there is nothing to build from.
 */
export function FirstBudget(props: {
  hostActions: HostActions;
  fallback: ReactNodeLike;
}): ReactNodeLike {
  const query = useToolQuery<DraftResult>("finance.budget.draft.get");
  const result =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;
  const draft = result?.draft ?? null;
  const needsBuild = result !== null && result.hasSynced === true && !result.hasBudget && !draft;

  const [polls, setPolls] = useState(0);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState<PendingPlans>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const sentAt = useRef<Record<string, number>>({});
  const [startSent, setStartSent] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const buildSent = useRef(false);
  // Start was clicked and is held until every typed amount has been saved.
  const [startWanted, setStartWanted] = useState(false);

  const sendBuild = (): void => {
    buildSent.current = true;
    void runWrite("finance.draft-build", "finance.draft-build").then((outcome) => {
      if (outcome.kind !== "queued") {
        setPolls(MAX_POLLS);
        announce("Couldn't start building your draft.");
      }
    });
  };

  // Ask for a draft once the first sync is in and none exists yet.
  useEffect(() => {
    if (!needsBuild || buildSent.current) return;
    sendBuild();
  }, [needsBuild]);

  // Re-read while waiting on the build or on a start that was sent.
  const startWaiting = startSent && draft?.status === "open";
  const waiting = (needsBuild && polls < MAX_POLLS) || (startWaiting && polls < MAX_POLLS);
  const watching = draft?.status === "open";
  useEffect(() => {
    if (!waiting && !watching) return;
    const timer = setTimeout(() => {
      if (waiting) setPolls((count) => count + 1);
      setTick((count) => count + 1);
      invalidateQueries();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, watching, polls, tick]);

  // A start the worker never finished stops waiting and offers a retry.
  useEffect(() => {
    if (!startWaiting || polls < MAX_POLLS) return;
    setStartSent(false);
    setStartError("Your budget did not start. Try again.");
    announce("Your budget did not start.");
  }, [startWaiting, polls]);

  // After each re-read: drop typed amounts the record now shows, and put back any the
  // worker never confirmed.
  useEffect(() => {
    if (!draft || Object.keys(pending).length === 0) return;
    const confirmed = new Set(confirmedPlans(pending, draft));
    const now = Date.now();
    const expired = Object.keys(pending).filter(
      (key) => !confirmed.has(key) && now - (sentAt.current[key] ?? now) > PENDING_GIVE_UP_MS
    );
    if (confirmed.size === 0 && expired.length === 0) return;
    setPending((previous) => {
      const next = { ...previous };
      for (const key of [...confirmed, ...expired]) delete next[key];
      return next;
    });
    if (expired.length > 0) {
      setErrors((previous) => {
        const next = { ...previous };
        for (const key of expired)
          next[key] = "Couldn't confirm the save. Put back to the old amount.";
        return next;
      });
      announce("Couldn't confirm the save.");
    }
  }, [query]);

  const onSave = (line: DraftLineView, cents: number): void => {
    if (!draft) return;
    setErrors((previous) => {
      const next = { ...previous };
      delete next[line.categoryKey];
      return next;
    });
    setPending((previous) => ({ ...previous, [line.categoryKey]: cents }));
    sentAt.current[line.categoryKey] = Date.now();
    // Metadata-only params: ids and cents.
    void runWrite("finance.draft-set", "finance.draft-set", {
      draftId: draft.id,
      categoryKey: line.categoryKey,
      amountCents: cents
    }).then((outcome) => {
      if (outcome.kind === "queued") return;
      setPending((previous) => {
        const next = { ...previous };
        delete next[line.categoryKey];
        return next;
      });
      setErrors((previous) => ({
        ...previous,
        [line.categoryKey]: "Couldn't save. Put back to the old amount."
      }));
      announce("Couldn't save.");
    });
  };

  const onBadAmount = (line: DraftLineView): void => {
    setErrors((previous) => ({
      ...previous,
      [line.categoryKey]: "Enter an amount like 250 or 250.50."
    }));
  };

  // A started draft, or any budget, means Getting started is done.
  const done = result !== null && (result.hasBudget === true || draft?.status === "started");
  useEffect(() => {
    if (done) navigate("/");
  }, [done]);

  const sendStart = (draftId: string): void => {
    setStartError(null);
    setStartSent(true);
    setPolls(0);
    void runWrite("finance.draft-start", "finance.draft-start", { draftId }).then((outcome) => {
      if (outcome.kind !== "queued") {
        setStartSent(false);
        setStartError("Couldn't start your budget. Try again.");
        announce("Couldn't start your budget.");
      }
    });
  };

  const onStart = (): void => {
    if (!draft) return;
    setStartError(null);
    setStartWanted(true);
  };

  // Start waits for typed amounts to be saved, so the budget starts with what is on screen.
  useEffect(() => {
    if (!startWanted || !draft || Object.keys(pending).length > 0) return;
    setStartWanted(false);
    if (Object.keys(errors).length > 0) {
      setStartError("Fix the amounts that didn't save, then start.");
      return;
    }
    sendStart(draft.id);
  }, [startWanted, pending, draft?.id]);

  const retryBuild = (): void => {
    setPolls(0);
    sendBuild();
    invalidateQueries();
  };

  return outcomeGate(
    query,
    (body) => {
      if (done) return <LoadingState label="Opening your budget" />;
      if (body.draft?.status === "open") {
        return (
          <FirstBudgetView
            draft={showPending<DraftLineView, DraftBody>(body.draft, pending)}
            errors={errors}
            onSave={onSave}
            onBadAmount={onBadAmount}
            hostActions={props.hostActions}
            starting={startSent || startWanted}
            startError={startError}
            onStart={onStart}
          />
        );
      }
      if (body.hasSynced !== true) return <>{props.fallback}</>;
      if (polls >= MAX_POLLS) {
        return (
          <div className="fnm-block fnm-block--tight">
            <Indicator status="error" label="Your draft could not be built." />
            <div>
              <Button variant="secondary" onClick={retryBuild}>
                Try again
              </Button>
            </div>
          </div>
        );
      }
      return <Indicator status="idle" label="Building your first budget" />;
    },
    { loadingLabel: "Loading" }
  );
}
