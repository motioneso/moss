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
import { formatCents, monthLabel, parseAmountToCents, centsToAmountInput } from "./format";
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
    (c) => !c.archived && c.id !== "income" && c.id !== "transfers"
  );
  return (
    <section className="fnm-block" aria-label="Category targets">
      <SectionHead title="Plan for what matters" rule />
      <p className="jds-hint">
        Targets guide your assignments. They use the money already in your categories.
      </p>
      {props.targets.length ? (
        <RowIndex density="compact">
          {props.targets.map((target) => (
            <RowIndexItem
              key={target.categoryId}
              title={
                categories.find((c) => c.id === target.categoryId)?.name ?? "Archived category"
              }
              excerpt={`${target.kind === "monthly" ? "Monthly contribution" : `Balance by ${target.dueDate}`} · ${formatCents(target.amountCents, props.currency)} · ${target.status === "reached" ? "Target reached" : `${formatCents(target.remainingCents, props.currency)} remaining${target.status === "overdue" ? " · overdue" : ""}${target.kind === "balance" ? ` · ${formatCents(target.suggestedCents, props.currency)} additional suggested` : ""}`}`}
              meta={
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!props.tools || disabled}
                  onClick={() => setEditing(target.categoryId)}
                >
                  Edit target
                </Button>
              }
            />
          ))}
        </RowIndex>
      ) : (
        <p>No targets yet. Set a monthly contribution or save toward a date.</p>
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
        <div className="fnm-block fnm-block--tight">
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
          categories={categories}
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
    initialId: string;
    onClose: () => void;
    onSaved: (fingerprint: string) => void;
  }
): ReactNodeLike {
  const existing = props.targets.find((t) => t.categoryId === props.initialId);
  const [categoryId, setCategory] = useState(props.initialId || props.categories[0]?.id || "");
  const [kind, setKind] = useState(existing?.kind === "balance" ? "balance" : "monthly");
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
  const save = async (remove = false) => {
    if (!props.tools || lock.current || blocked) return;
    if (
      !remove &&
      (cents === null || cents <= 0 || (kind === "balance" && !isCalendarDate(dueDate)))
    ) {
      setMessage("Enter a positive amount and a valid target date when needed.");
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
      title={existing ? "Edit target" : "Add a target"}
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
          <Button disabled={busy || blocked} onClick={() => void save()}>
            {busy ? "Saving…" : "Save target"}
          </Button>
        </div>
      }
    >
      <div className="fnm-block">
        <Note variant="practical">
          Saving a target does not assign money. Earlier months keep their target history.
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
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) => setKind(e.currentTarget.value)}
          >
            <option value="monthly">Monthly contribution</option>
            <option value="balance">Balance by a date</option>
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Amount ({props.currency})
          <input
            className="jds-input"
            aria-label="Target amount"
            inputMode="decimal"
            value={amount}
            disabled={busy}
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
              disabled={busy}
              onChange={(e: { currentTarget: { value: string } }) => setDate(e.currentTarget.value)}
            />
          </label>
        ) : null}
        <p className="jds-hint">
          {kind === "monthly"
            ? "Progress counts this month's assigned money, independent of spending and rollover."
            : "Progress counts the category's available money. Spending reduces progress."}
        </p>
        {message ? <p role="alert">{message}</p> : null}
      </div>
    </Dialog>
  );
}
