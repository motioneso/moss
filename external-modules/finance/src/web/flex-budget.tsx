import {
  Badge,
  Button,
  Dialog,
  DisclosureToggle,
  Note,
  RowIndex,
  RowIndexItem,
  SectionHead,
  Select,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { FLEX_POOL, type FlexPolicy } from "../domain/flex";
import { formatCents, parseAmountToCents } from "./format";
import { invalidateQueries } from "./store";
interface Choice {
  id: string;
  name: string;
  group: string;
}
export interface FlexBudgetView {
  month: string;
  currentMonth: string;
  isoCurrency: string;
  revision: number;
  fingerprint: string;
  flex: FlexPolicy | null;
  flexChoices: Choice[];
  flexDetail: { id: string; name: string; activityCents: number; guidanceCents: number }[];
  state: {
    categories: Record<
      string,
      { assignedCents: number; activityCents: number; availableCents: number }
    >;
  };
}
export function FlexBudgetPanel(props: {
  disabled?: boolean;
  data: FlexBudgetView;
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState(false);
  const d = props.data;
  const active = d.flex?.active === true;
  return (
    <section className="fnm-block fnm-block--tight" aria-label="Budget planning mode">
      <SectionHead title="Planning mode" rule />
      <div className="fnm-spread">
        <Badge>{active ? "Flexible pool" : "Category envelopes"}</Badge>
        <Button
          size="sm"
          variant="secondary"
          disabled={
            props.disabled ||
            !props.tools ||
            d.month !== d.currentMonth ||
            (active && (d.state.categories[FLEX_POOL]?.availableCents ?? 0) < 0)
          }
          onClick={() => setOpen(true)}
        >
          {active ? "Return to envelopes" : "Set up flexible budget"}
        </Button>
      </div>
      {props.disabled ? (
        <p className="jds-hint">
          Save or clear typed amounts and check saved records before changing mode.
        </p>
      ) : null}
      {active && (d.state.categories[FLEX_POOL]?.availableCents ?? 0) < 0 ? (
        <Note variant="practical">
          Cover the flexible pool's overspending before returning to envelopes.
        </Note>
      ) : null}
      {d.month !== d.currentMonth ? (
        <p className="jds-hint">Change planning mode in the current month.</p>
      ) : null}
      {active ? (
        <>
          <DisclosureToggle
            expanded={detail}
            className="fnm-disclosure-head"
            onClick={() => setDetail(!detail)}
          >
            Flexible spending detail
            <span className="fnm-disclosure-marker" aria-hidden="true" />
          </DisclosureToggle>
          {detail ? (
            <div className="fnm-block">
              <RowIndex density="compact">
                {d.flexDetail.map((row) => (
                  <RowIndexItem
                    key={row.id}
                    title={row.name}
                    excerpt={
                      row.guidanceCents
                        ? `${formatCents(row.guidanceCents, d.isoCurrency)} original category guidance · not additional funding`
                        : "No separate category funding"
                    }
                    meta={`${formatCents(row.activityCents, d.isoCurrency)} spent`}
                  />
                ))}
              </RowIndex>
            </div>
          ) : null}
        </>
      ) : null}
      {open ? <FlexModeDialog data={d} tools={props.tools} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
interface Preview extends Record<string, unknown> {
  revision: number;
  fingerprint: string;
  poolAssignedCents: number;
  poolActivityCents: number;
  poolAvailableCents: number;
  readyBeforeCents: number;
  readyAfterCents: number;
}
function FlexModeDialog(props: {
  data: FlexBudgetView;
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
}): ReactNodeLike {
  const [d] = useState(props.data);
  const leaving = d.flex?.active === true;
  const members = d.flexChoices.filter((c) => d.flex?.flexIds.includes(c.id));
  const [groups, setGroups] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      d.flexChoices.map((c) => [
        c.id,
        c.group === "savings-goals"
          ? "nonmonthly"
          : ["everyday", "personal"].includes(c.group)
            ? "flex"
            : "fixed"
      ])
    )
  );
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const [reviewedInput, setReviewedInput] = useState<Record<string, unknown> | null>(null);
  const makeInput = () => {
    if (!leaving)
      return {
        month: d.month,
        mode: "flex",
        flexIds: d.flexChoices.filter((c) => groups[c.id] === "flex").map((c) => c.id),
        nonMonthlyIds: d.flexChoices.filter((c) => groups[c.id] === "nonmonthly").map((c) => c.id)
      };
    const distribution = Object.fromEntries(
      members.map((c) => {
        const n = parseAmountToCents(amounts[c.id] ?? "");
        if (n === null || n < 0)
          throw new Error("Enter a nonnegative available amount for every flexible category.");
        return [c.id, n];
      })
    );
    return { month: d.month, mode: "envelopes", distribution };
  };
  const review = async () => {
    if (!props.tools || busy || blocked) return;
    setBusy(true);
    setMessage(null);
    try {
      const input = makeInput();
      const result = await props.tools.invoke("finance.flex.preview", input);
      if (result.status === "succeeded" && result.result.status === "ok") {
        setPreview(result.result as Preview);
        setReviewedInput(input);
      } else {
        const code = result.status === "rejected" ? result.moduleCode : undefined;
        const errors: Record<string, string> = {
          future_assignments:
            "Clear nonzero future assignments before changing mode. They will not be rewritten.",
          open_draft: "Finish the open first-budget draft before changing mode.",
          flex_target:
            "Move or remove current and future targets on the proposed flexible categories before pooling their money.",
          current_month_required: "Open the current budget month to change planning mode."
        };
        setMessage(
          code && errors[code]
            ? errors[code]!
            : "Review your categories and destinations. Every available cent must have a destination; cover pool overspending before leaving."
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The preview could not load. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!props.tools || !preview || !reviewedInput || busy || blocked) return;
    setBusy(true);
    try {
      const result = await props.tools.invoke("finance.flex.configure", {
        ...reviewedInput,
        expectedRevision: preview.revision,
        expectedFingerprint: preview.fingerprint
      });
      if (result.status === "succeeded" && result.result.status === "ok") {
        invalidateQueries();
        props.onClose();
      } else if (result.status === "cancelled")
        setMessage("Cancelled. Your choices and preview are kept.");
      else {
        setBlocked(true);
        setMessage(
          "The review changed or saving could not be confirmed. Your choices are kept. Close this form and check saved records before trying again."
        );
      }
    } catch {
      setBlocked(true);
      setMessage("Check saved records before trying again. Your choices are kept.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={leaving ? "Return to category envelopes" : "Set up a flexible budget"}
      description={`${d.month} · ${d.isoCurrency}`}
      scrollBody
      closeLabel="Close"
      closeDisabled={busy}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      footer={
        <div className="fnm-spread">
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          {preview ? (
            <Button disabled={busy || blocked} onClick={() => void save()}>
              Confirm mode change
            </Button>
          ) : (
            <Button disabled={busy || blocked} onClick={() => void review()}>
              Review mode change
            </Button>
          )}
        </div>
      }
    >
      <div className="fnm-block">
        <Note variant="practical">
          {leaving
            ? `Choose where the pool's ${formatCents(d.state.categories[FLEX_POOL]?.availableCents ?? 0, d.isoCurrency)} available money goes. Old category amounts will not be restored on top.`
            : "Flexible categories share one funded total. Their existing assignments become guidance, and their spending and carry count once in the pool. Pooling can cover one member's overspending with another member's money."}
        </Note>
        {leaving
          ? members.map((c) => (
              <label key={c.id} className="fnm-block fnm-block--tight">
                Available for {c.name}
                <input
                  className="jds-input"
                  aria-label={`Available for ${c.name}`}
                  inputMode="decimal"
                  disabled={busy}
                  value={amounts[c.id] ?? ""}
                  onChange={(e: { currentTarget: { value: string } }) => {
                    const value = e.currentTarget.value;
                    setAmounts((old) => ({ ...old, [c.id]: value }));
                    setPreview(null);
                  }}
                />
              </label>
            ))
          : d.flexChoices.map((c) => (
              <label key={c.id} className="fnm-block fnm-block--tight">
                {c.name}
                <Select
                  aria-label={`Grouping for ${c.name}`}
                  value={groups[c.id]}
                  disabled={busy}
                  onChange={(e: { currentTarget: { value: string } }) => {
                    const value = e.currentTarget.value;
                    setGroups((old) => ({ ...old, [c.id]: value }));
                    setPreview(null);
                  }}
                >
                  <option value="fixed">Fixed</option>
                  <option value="nonmonthly">Non-monthly</option>
                  <option value="flex">Flexible</option>
                </Select>
              </label>
            ))}
        {preview ? (
          <section className="fnm-block" aria-label="Mode change preview">
            <SectionHead title="Review the money" rule />
            <RowIndex variant="facts">
              <RowIndexItem
                title="Pool assigned"
                meta={formatCents(preview.poolAssignedCents, d.isoCurrency)}
              />
              <RowIndexItem
                title="Pool spent"
                meta={formatCents(preview.poolActivityCents, d.isoCurrency)}
              />
              <RowIndexItem
                title="Available to allocate"
                meta={formatCents(preview.poolAvailableCents, d.isoCurrency)}
              />
              <RowIndexItem
                title="Ready before"
                meta={formatCents(preview.readyBeforeCents, d.isoCurrency)}
              />
              <RowIndexItem
                title="Ready after"
                meta={formatCents(preview.readyAfterCents, d.isoCurrency)}
              />
            </RowIndex>
            <p className="jds-hint">
              Your saved budget changes only after confirmation. Transaction categories and previous
              months stay intact.
            </p>
          </section>
        ) : null}
        {message ? <p role="alert">{message}</p> : null}
      </div>
    </Dialog>
  );
}
