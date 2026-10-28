// external-modules/finance/src/web/screens/first-budget.tsx
//
// #3180: the first-budget draft on Getting started. The numbers all come from the stored
// draft (finance.budget.draft.get); this screen only lays them out. Matches mockup
// 05-first-budget. A plan amount is typed in place and saved through guarded host tools; chat
// changes land in the same record. The header total contains committed plan amounts only.
//
// After the first sync the screen awaits a stored draft. Starting requires the guarded
// host confirmation and opens Budget only after the atomic start succeeds.
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
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { formatCents, monthLabel, parseAmountToCents } from "../format";
import { navigate } from "../router";
import { announce, LoadingState, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";
import type { HostActions } from "../root";

export interface DraftLineView {
  isoCurrency?: string;
  categoryKey: string;
  categoryName: string;
  basisMonthlyCents: number;
  planCents: number;
  dropped: boolean;
  changedByMoss: boolean;
  proposedCents: number;
}

export interface DraftBody {
  isoCurrency?: string;
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
  revision?: number;
  fingerprint?: string;
  setupRequired?: boolean;
  hasSynced?: boolean;
  hasBudget?: boolean;
  draft?: DraftBody | null;
}

const money = (cents: number, currency?: string): string =>
  currency ? formatCents(cents, currency) : "Unavailable";

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
  const income = money(draft.monthlyIncomeCents, draft.isoCurrency);
  if (draft.unplannedCents < 0) {
    return `${span} The plan is ${money(-draft.unplannedCents, draft.isoCurrency)} over your ${income} monthly income.`;
  }
  return `${span} ${money(draft.unplannedCents, draft.isoCurrency)} of your ${income} monthly income is still unplanned.`;
}

interface EditProps {
  errors: Record<string, string>;
  drafts: Record<string, string>;
  disabled: boolean;
  onDraft: (id: string, value: string | null) => void;
  onSave: (line: DraftLineView, cents: number) => void;
  onBadAmount: (line: DraftLineView) => void;
}
function PlanCell(props: { line: DraftLineView } & EditProps): ReactNodeLike {
  const { line } = props;
  const typed = props.drafts[line.categoryKey];
  const finish = () => {
    if (typed === undefined || props.disabled) return;
    const cents = parseAmountToCents(typed);
    if (cents === null || cents < 0) props.onBadAmount(line);
    else if (cents !== line.planCents || line.dropped) props.onSave(line, cents);
    else props.onDraft(line.categoryKey, null);
  };
  const error = props.errors[line.categoryKey];
  return (
    <div className="fnm-assign">
      <input
        className="jds-input jds-input--sm fnm-assign__input"
        aria-label={`Plan for ${line.categoryName}`}
        aria-invalid={error ? "true" : undefined}
        inputMode="decimal"
        disabled={props.disabled}
        value={typed ?? (line.dropped ? "" : money(line.planCents, line.isoCurrency))}
        placeholder={line.dropped ? "Not in budget" : undefined}
        onFocus={(event: { currentTarget: { select: () => void } }) => {
          event.currentTarget.select();
        }}
        onBlur={() => {
          if (typed !== undefined && !line.dropped && parseAmountToCents(typed) === line.planCents)
            props.onDraft(line.categoryKey, null);
        }}
        onChange={(event: { currentTarget: { value: string } }) =>
          props.onDraft(line.categoryKey, event.currentTarget.value)
        }
        onKeyDown={(event: { key: string; preventDefault: () => void }) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish();
          }
          if (event.key === "Escape") props.onDraft(line.categoryKey, null);
        }}
      />
      {typed !== undefined && (parseAmountToCents(typed) !== line.planCents || line.dropped) ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={props.disabled}
          aria-label={`Save plan for ${line.categoryName}`}
          onClick={finish}
        >
          Save
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="jds-hint fnm-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ChatChange(props: { line: DraftLineView }): ReactNodeLike {
  if (!props.line.changedByMoss) return null;
  return (
    <div>
      <Badge tone="forest">
        {props.line.dropped
          ? "Removed from the plan"
          : `Adjusted, was ${money(props.line.proposedCents, props.line.isoCurrency)}`}
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
              <td className="jds-table__num jds-hint">
                {money(line.basisMonthlyCents, line.isoCurrency)}
              </td>
              <td className="jds-table__num">
                <PlanCell line={line} {...props} />
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
                <span>Average {money(line.basisMonthlyCents, line.isoCurrency)}</span>
              </div>
            }
            meta={<PlanCell line={line} {...props} />}
          />
        ))}
      </RowIndex>
    </section>
  );
}

export interface FirstBudgetViewProps extends EditProps {
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
        title={`${money(draft.totalCents, draft.isoCurrency)} a month`}
        lede={unplannedLede(draft)}
        aside={
          <div className="fnm-block fnm-block--tight">
            <Button variant="field" onClick={props.onStart} disabled={props.disabled}>
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
            <DraftTable group={group} head={index === 0} {...props} />
          </div>
          <div className="fnm-phone-only">
            <DraftRows group={group} {...props} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Reads the draft and drives it: builds one after the first sync, shows an open
 * one, and sends the user to Budget once a budget exists. `fallback` renders
 * before the first sync, when there is nothing to build from.
 */
export function FirstBudget(props: {
  hostActions: HostActions;
  tools?: ExternalModuleToolsHandleV1;
  fallback: ReactNodeLike;
}): ReactNodeLike {
  const query = useToolQuery<DraftResult>("finance.budget.draft.get");
  const result =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;
  const draft = result?.draft ?? null;
  const needsBuild =
    result !== null &&
    !result.setupRequired &&
    result.hasSynced === true &&
    !result.hasBudget &&
    !draft;
  const [buildError, setBuildError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const building = useRef(false);
  const saving = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const sendBuild = () => {
    if (!props.tools) return;
    building.current = true;
    setBuildError(null);
    void props.tools
      .invoke("finance.budget.draft.build", {})
      .then((outcome) => {
        if (!live.current) return;
        if (outcome.status === "succeeded" && outcome.result.status === "ok") {
          if (outcome.result.reason === "no-history")
            setBuildError("There is not enough usable history to build a draft yet.");
          invalidateQueries();
        } else
          setBuildError(
            "The draft build could not be confirmed. Check the saved draft before trying again."
          );
      })
      .catch(() => {
        if (live.current)
          setBuildError(
            "The draft build could not be confirmed. Check the saved draft before trying again."
          );
      });
  };
  useEffect(() => {
    if (needsBuild && props.tools && !building.current) sendBuild();
  }, [needsBuild]);
  const done = result !== null && (result.hasBudget === true || draft?.status === "started");
  useEffect(() => {
    if (done) navigate("/");
    if (checking && result) {
      setChecking(false);
      setUncertain(false);
      setMessage("Saved draft refreshed. Review your typed amounts before saving.");
    }
  }, [query]);
  const onDraft = (id: string, value: string | null) => {
    setDrafts((old) => {
      const next = { ...old };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });
    setErrors((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  };
  const write = async (
    tool: string,
    input: Record<string, string | number>,
    categoryKey?: string
  ) => {
    if (
      !props.tools ||
      !result?.fingerprint ||
      result.revision === undefined ||
      saving.current ||
      uncertain
    )
      return;
    saving.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await props.tools.invoke(tool, {
        ...input,
        expectedRevision: result.revision,
        expectedFingerprint: result.fingerprint
      });
      if (!live.current) return;
      if (outcome.status === "succeeded" && outcome.result.status === "ok") {
        if (categoryKey) onDraft(categoryKey, null);
        announce(categoryKey ? "Draft amount saved." : "Budget started.");
        invalidateQueries();
        if (!categoryKey) navigate("/");
      } else if (outcome.status === "cancelled")
        setMessage("Cancelled. Your draft and typed amounts are kept.");
      else if (outcome.status === "rejected" || outcome.status === "invalid_input") {
        setMessage("Not saved. Refresh and review the draft again. Your typed amounts are kept.");
        invalidateQueries();
      } else {
        setUncertain(true);
        setMessage("The save could not be confirmed. Check the saved draft before trying again.");
      }
    } catch {
      if (live.current) {
        setUncertain(true);
        setMessage("The save could not be confirmed. Check the saved draft before trying again.");
      }
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  };
  const onSave = (line: DraftLineView, cents: number) => {
    if (draft)
      void write(
        "finance.budget.draft.update",
        { draftId: draft.id, categoryKey: line.categoryKey, amountCents: cents },
        line.categoryKey
      );
  };
  const onStart = () => {
    if (!draft) return;
    const lines = draft.groups.flatMap((group) => group.lines);
    if (
      Object.entries(drafts).some(
        ([key, value]) =>
          parseAmountToCents(value) !== lines.find((line) => line.categoryKey === key)?.planCents
      )
    ) {
      setMessage("Save your typed amounts before starting this budget.");
      return;
    }
    void write("finance.budget.draft.start", { draftId: draft.id });
  };
  return (
    <div className="fnm-block">
      {message ? <p role="status">{message}</p> : null}
      {draft ? (
        <div className="fnm-inline">
          <p className="jds-hint">
            Totals show saved amounts. Press Enter or Save after editing a plan.
          </p>
          <Button
            variant="secondary"
            disabled={busy || checking}
            onClick={() => {
              setChecking(true);
              invalidateQueries();
            }}
          >
            {checking ? "Refreshing…" : "Check saved draft"}
          </Button>
        </div>
      ) : null}
      {!props.tools && draft ? (
        <Note variant="practical">Update Moss to save and start a reviewed budget.</Note>
      ) : null}
      {outcomeGate(
        query,
        (body) => {
          if (body.setupRequired)
            return (
              <div className="fnm-block">
                <Note variant="practical">
                  Choose your budget currency before building a plan from your history.
                </Note>
                <Button onClick={() => navigate("/")}>Choose budget currency</Button>
              </div>
            );
          if (done) return <LoadingState label="Opening your budget" />;
          if (body.draft?.status === "open")
            return (
              <FirstBudgetView
                draft={body.draft}
                drafts={drafts}
                disabled={busy || uncertain || !props.tools}
                onDraft={onDraft}
                errors={errors}
                onSave={onSave}
                onBadAmount={(line) =>
                  setErrors((old) => ({
                    ...old,
                    [line.categoryKey]: "Enter an amount like 250 or 250.50."
                  }))
                }
                hostActions={props.hostActions}
                starting={busy}
                startError={null}
                onStart={onStart}
              />
            );
          if (body.hasSynced !== true) return <>{props.fallback}</>;
          if (buildError || !props.tools)
            return (
              <div className="fnm-block">
                <Note variant="practical">
                  {buildError ?? "Update Moss to build a reviewed draft."} You can also assign
                  amounts directly on Budget.
                </Note>
                <div className="fnm-inline">
                  <Button onClick={() => navigate("/")}>Open Budget</Button>
                  <Button variant="secondary" disabled={!props.tools} onClick={sendBuild}>
                    Try again
                  </Button>
                </div>
              </div>
            );
          return <Indicator status="idle" label="Building your first budget" />;
        },
        { loadingLabel: "Loading" }
      )}
    </div>
  );
}
