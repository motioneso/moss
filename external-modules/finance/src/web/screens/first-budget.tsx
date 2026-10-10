// external-modules/finance/src/web/screens/first-budget.tsx
//
// #3180: the first-budget draft on Getting started. The numbers all come from the stored
// draft (finance.budget.draft.get); this screen only lays them out. Matches mockup
// 05-first-budget. Plan amounts are read-only here; typing a plan in place and chat
// changes arrive with the adjust ticket (#3181).
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
import { formatCents, monthLabel } from "../format";
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

function PlanCell(props: { line: DraftLineView }): ReactNodeLike {
  return props.line.dropped ? (
    <span className="jds-hint">Not in budget</span>
  ) : (
    <span>{money(props.line.planCents)}</span>
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

function DraftTable(props: { group: DraftBody["groups"][number]; head: boolean }): ReactNodeLike {
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
                <PlanCell line={line} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DraftRows(props: { group: DraftBody["groups"][number] }): ReactNodeLike {
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
            meta={line.dropped ? "Not in budget" : <strong>Plan {money(line.planCents)}</strong>}
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
            <DraftTable group={group} head={index === 0} />
          </div>
          <div className="fnm-phone-only">
            <DraftRows group={group} />
          </div>
        </div>
      ))}
    </div>
  );
}

const POLL_MS = 3000;
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
  const [startSent, setStartSent] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const buildSent = useRef(false);

  // Ask for a draft once the first sync is in and none exists yet.
  useEffect(() => {
    if (!needsBuild || buildSent.current) return;
    buildSent.current = true;
    void runWrite("finance.draft-build", "finance.draft-build").then((outcome) => {
      if (outcome.kind !== "queued") {
        setPolls(MAX_POLLS);
        announce("Couldn't start building your draft.");
      }
    });
  }, [needsBuild]);

  // Re-read while waiting on the build or on a start that was sent.
  const waiting = (needsBuild && polls < MAX_POLLS) || (startSent && draft?.status === "open");
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setPolls((count) => count + 1);
      invalidateQueries();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, polls]);

  // A started draft, or any budget, means Getting started is done.
  const done = result !== null && (result.hasBudget === true || draft?.status === "started");
  useEffect(() => {
    if (done) navigate("/");
  }, [done]);

  const onStart = (): void => {
    if (!draft) return;
    setStartError(null);
    setStartSent(true);
    setPolls(0);
    void runWrite("finance.draft-start", "finance.draft-start", { draftId: draft.id }).then(
      (outcome) => {
        if (outcome.kind !== "queued") {
          setStartSent(false);
          setStartError("Couldn't start your budget. Try again.");
          announce("Couldn't start your budget.");
        }
      }
    );
  };

  const retryBuild = (): void => {
    buildSent.current = false;
    setPolls(0);
    invalidateQueries();
  };

  return outcomeGate(
    query,
    (body) => {
      if (done) return <LoadingState label="Opening your budget" />;
      if (body.draft?.status === "open") {
        return (
          <FirstBudgetView
            draft={body.draft}
            hostActions={props.hostActions}
            starting={startSent}
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
