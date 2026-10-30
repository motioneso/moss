import { WEEKDAYS, weeklyTargetPeriod, type WeeklyTargetPeriod } from "../domain/weekly-targets";
import { targetDescription, weeklyPeriodLabel } from "./target-description";
import { FLEX_POOL } from "../domain/flex";
import { TargetFundingDialog } from "./target-funding-dialog";
import type { TargetFundingLine } from "../domain/target-funding";
import {
  Button,
  Dialog,
  Note,
  Select,
  SectionHead,
  RowIndex,
  RowIndexItem,
  useState,
  useRef,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { TargetProgress } from "../domain/targets";
import { monthLabel, parseAmountToCents, centsToAmountInput } from "./format";
import { isCalendarDate } from "../domain/values";
import { invalidateQueries } from "./store";
interface BudgetTargetsProps {
  month: string;
  currency: string;
  revision: number;
  fingerprint: string;
  categories: { id: string; name: string; archived?: boolean }[];
  targets: TargetProgress[];
  disabled?: boolean;
  funding?: {
    currentMonth: string;
    readyCents: number | null;
    lines: TargetFundingLine[];
    overspent?: boolean;
  };
  onUncertain?: () => void;
  tools?: ExternalModuleToolsHandleV1;
}
export function BudgetTargets(props: BudgetTargetsProps): ReactNodeLike {
  const [awaitingFingerprint, setAwaitingFingerprint] = useState<string | null>(null);
  const waiting = awaitingFingerprint !== null && awaitingFingerprint === props.fingerprint;
  const disabled = props.disabled || waiting;
  const [funding, setFunding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const categories = props.categories.filter(
    (c) => !c.archived && c.id !== "income" && c.id !== "transfers" && c.id !== FLEX_POOL
  );
  const targetName = (id: string) =>
    props.categories.find((c) => c.id === id)?.name ??
    props.funding?.lines.find((line) => line.categoryId === id)?.name ??
    "Unavailable category";
  const canEdit = !editing || categories.some((c) => c.id === editing);
  const editorCategories =
    editing && !canEdit ? [...categories, { id: editing, name: targetName(editing) }] : categories;
  return (
    <section className="fnm-block" aria-label="Category targets">
      <SectionHead title="Plan for what matters" rule />
      <p className="jds-hint">
        Set a plan for each category. Funding is a separate, reviewed choice.
      </p>
      {props.targets.length ? (
        <RowIndex density="compact">
          {props.targets.map((target) => (
            <RowIndexItem
              key={target.categoryId}
              title={targetName(target.categoryId)}
              excerpt={targetDescription(target, props.currency, props.month)}
              meta={
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!props.tools || disabled}
                  onClick={() => setEditing(target.categoryId)}
                >
                  {categories.some((c) => c.id === target.categoryId)
                    ? "Edit target"
                    : "Review old target"}
                </Button>
              }
            />
          ))}
        </RowIndex>
      ) : (
        <p>No targets yet. Choose contributions, monthly refill, or dated savings.</p>
      )}
      <div>
        <Button
          variant="secondary"
          disabled={!props.tools || disabled || !categories.length}
          onClick={() => setEditing("")}
        >
          Add a target
        </Button>
      </div>
      {waiting ? (
        <p role="status">
          Refreshing saved target totals. If this stays here, check saved records.
        </p>
      ) : null}
      {props.targets.length > 0 && props.funding ? (
        <div className="fnm-block fnm-block--tight fnm-account-management">
          <div>
            <Button
              variant="secondary"
              disabled={
                !props.tools ||
                disabled ||
                props.month !== props.funding.currentMonth ||
                props.funding.overspent ||
                props.funding.readyCents === null ||
                props.funding.readyCents <= 0 ||
                !props.funding.lines.some((line) => !line.unavailableReason)
              }
              onClick={() => setFunding(true)}
            >
              Review target funding
            </Button>
          </div>
          <p className="jds-hint">
            {props.month !== props.funding.currentMonth
              ? "Fund targets from the current month."
              : props.funding.overspent
                ? "Cover category overspending before funding targets. Assign or move money to those categories, then check saved records."
                : props.funding.readyCents === null
                  ? "Ready to assign is unavailable. Check the saved budget before funding targets."
                  : props.funding.readyCents <= 0
                    ? "Assign new ready money before adding target contributions."
                    : !props.funding.lines.some((line) => !line.unavailableReason)
                      ? "No eligible target suggestions. Reached targets need no additional contribution; pooled categories use their flexible pool."
                      : "Choose current suggestions, review the assignment totals, then confirm. No automatic funding."}
          </p>
        </div>
      ) : null}
      {funding && props.funding ? (
        <TargetFundingDialog
          data={{
            month: props.month,
            currency: props.currency,
            revision: props.revision,
            fingerprint: props.fingerprint,
            readyCents: props.funding.readyCents,
            lines: props.funding.lines
          }}
          tools={props.tools}
          onClose={() => setFunding(false)}
          onSaved={setAwaitingFingerprint}
          onUncertain={() => props.onUncertain?.()}
        />
      ) : null}
      {editing !== null ? (
        <TargetDialog
          key={editing}
          {...props}
          categories={editorCategories}
          canEdit={canEdit}
          initialId={editing}
          onClose={() => setEditing(null)}
          onSaved={setAwaitingFingerprint}
        />
      ) : null}
    </section>
  );
}
function TargetDialog(
  props: BudgetTargetsProps & {
    canEdit: boolean;
    initialId: string;
    onClose: () => void;
    onSaved: (fingerprint: string) => void;
  }
): ReactNodeLike {
  const existing = props.targets.find((t) => t.categoryId === props.initialId);
  const [categoryId, setCategory] = useState(props.initialId || props.categories[0]?.id || "");
  const [kind, setKind] = useState<string>(
    existing && existing.kind !== "removed" ? existing.kind : "monthly"
  );
  const [weekday, setWeekday] = useState(
    existing?.weekday === undefined ? "" : String(existing.weekday)
  );
  const [amount, setAmount] = useState(existing ? centsToAmountInput(existing.amountCents) : "");
  const [dueDate, setDate] = useState(existing?.dueDate ?? "");
  const [review] = useState({
    expectedRevision: props.revision,
    expectedFingerprint: props.fingerprint
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const lock = useRef(false);
  const close = () => {
    if (!lock.current) props.onClose();
  };
  const cents = parseAmountToCents(amount);
  let weekly: WeeklyTargetPeriod | null = null;
  if (kind === "weekly" && weekday !== "" && cents !== null) {
    try {
      weekly = weeklyTargetPeriod(props.month, Number(weekday), cents);
    } catch {
      /* Keep invalid amounts unsaved. */
    }
  }
  const save = async (remove = false) => {
    if (!props.tools || lock.current || blocked || (!remove && !props.canEdit)) return;
    if (
      !remove &&
      (cents === null ||
        cents <= 0 ||
        (kind === "balance" && !isCalendarDate(dueDate)) ||
        (kind === "weekly" && !weekly))
    ) {
      setMessage(
        "Enter a positive supported amount and choose the required target date or weekday."
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const result = await props.tools.invoke("finance.target.set", {
        month: props.month,
        categoryId,
        kind: remove ? "removed" : kind,
        amountCents: remove ? 0 : cents!,
        ...(kind === "balance" && !remove ? { dueDate } : {}),
        ...(kind === "weekly" && !remove ? { weekday: Number(weekday) } : {}),
        ...review
      });
      if (result.status === "succeeded" && result.result.status === "ok") {
        invalidateQueries();
        props.onSaved(review.expectedFingerprint);
        props.onClose();
      } else if (result.status === "cancelled") setMessage("Cancelled. Your entries are kept.");
      else {
        setBlocked(true);
        props.onUncertain?.();
        setMessage(
          "Saving could not be confirmed or the budget changed. Close this form, check saved records, and review the target before trying again."
        );
        invalidateQueries();
      }
    } catch {
      setBlocked(true);
      props.onUncertain?.();
      setMessage("Check saved records before trying again. Your entries are kept here.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={!props.canEdit ? "Review old target" : existing ? "Edit target" : "Add a target"}
      description={`From ${monthLabel(props.month)} onward · ${props.currency}`}
      scrollBody
      closeDisabled={busy}
      onClose={close}
      footer={
        <div className="fnm-spread">
          <Button variant="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {existing ? (
            <Button variant="secondary" disabled={busy || blocked} onClick={() => void save(true)}>
              Remove target
            </Button>
          ) : null}
          <Button
            disabled={busy || blocked || !props.canEdit || (kind === "weekly" && !weekly)}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save target"}
          </Button>
        </div>
      }
    >
      <div className="fnm-block fnm-block--tight fnm-account-management">
        <Note variant="practical">
          {props.canEdit
            ? "Saving a target does not assign money. Earlier months keep their target history."
            : "This category is archived or funded through the flexible pool. You can remove the old target; assigned money and earlier target history stay intact."}
        </Note>
        <label className="fnm-block fnm-block--tight">
          Category
          <Select
            aria-label="Target category"
            value={categoryId}
            disabled={Boolean(existing) || busy}
            onChange={(e: { currentTarget: { value: string } }) =>
              setCategory(e.currentTarget.value)
            }
          >
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Target type
          <Select
            aria-label="Target type"
            value={kind}
            disabled={busy || !props.canEdit}
            onChange={(e: { currentTarget: { value: string } }) => setKind(e.currentTarget.value)}
          >
            <option value="monthly">Monthly contribution</option>
            <option value="weekly">Weekly contribution</option>
            <option value="refill">Monthly refill</option>
            <option value="balance">Balance by a date</option>
          </Select>
        </label>
        {kind === "weekly" ? (
          <label className="fnm-block fnm-block--tight">
            Contribution weekday
            <Select
              aria-label="Contribution weekday"
              value={weekday}
              disabled={busy || !props.canEdit}
              onChange={(e: { currentTarget: { value: string } }) =>
                setWeekday(e.currentTarget.value)
              }
            >
              <option value="">Choose a weekday</option>
              {WEEKDAYS.map((name, day) => (
                <option key={day} value={String(day)}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label className="fnm-block fnm-block--tight">
          {kind === "weekly" ? "Weekly amount" : "Amount"} ({props.currency})
          <input
            className="jds-input"
            aria-label="Target amount"
            inputMode="decimal"
            value={amount}
            disabled={busy || !props.canEdit}
            onChange={(e: { currentTarget: { value: string } }) => setAmount(e.currentTarget.value)}
          />
        </label>
        {kind === "balance" ? (
          <label className="fnm-block fnm-block--tight">
            Target date
            <input
              className="jds-input"
              aria-label="Target date"
              type="date"
              value={dueDate}
              disabled={busy || !props.canEdit}
              onChange={(e: { currentTarget: { value: string } }) => setDate(e.currentTarget.value)}
            />
          </label>
        ) : null}
        {kind === "weekly" ? (
          <p role="status">
            {weekly
              ? weeklyPeriodLabel(weekly, props.currency, props.month)
              : "Choose a weekday and a supported weekly amount to preview the full month."}
          </p>
        ) : null}
        <p className="jds-hint">
          {kind === "weekly"
            ? "Full-month plan, including when created mid-month. Progress counts new assignments, independent of spending and rollover. Funding is always a separate reviewed choice."
            : kind === "refill"
              ? "Counts carried money plus this month's assignments. Spending and refunds during the month do not change this plan. Future carry is provisional. Funding is a separate reviewed choice."
              : kind === "monthly"
                ? "Progress counts this month's assigned money, independent of spending and rollover."
                : "Progress counts the category's available money. Spending reduces progress."}
        </p>
        {message ? <p role="alert">{message}</p> : null}
      </div>
    </Dialog>
  );
}
