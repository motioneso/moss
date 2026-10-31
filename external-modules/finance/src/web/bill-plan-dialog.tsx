import {
  Button,
  Dialog,
  Select,
  randomUuid,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { BillsView } from "./screens/upcoming";
import { centsToAmountInput, parseAmountToCents } from "./format";
import { isCalendarDate } from "../domain/values";
import { invalidateQueries } from "./store";
export interface BillPlanDraft {
  name: string;
  accountId: string;
  categoryId: string | null;
  amountCents: number;
  anchorDate: string;
  cadence: string;
}

export function BillPlanDialog(props: {
  data: BillsView;
  tools?: ExternalModuleToolsHandleV1;
  /** Starting values, such as a suggested bill. Unknown accounts and categories start blank. */
  initial?: BillPlanDraft;
  onClose: () => void;
}): ReactNodeLike {
  const initial = props.initial;
  const [id] = useState(() => randomUuid());
  const [review] = useState({
    expectedRevision: props.data.revision,
    expectedFingerprint: props.data.fingerprint
  });
  const [name, setName] = useState(initial?.name.slice(0, 160) ?? "");
  const [accountId, setAccount] = useState(
    initial && props.data.accounts.some((a) => a.accountId === initial.accountId)
      ? initial.accountId
      : ""
  );
  const [categoryId, setCategory] = useState(
    initial?.categoryId && props.data.categories.some((c) => c.id === initial.categoryId)
      ? initial.categoryId
      : ""
  );
  const [amount, setAmount] = useState(initial ? centsToAmountInput(initial.amountCents) : "");
  const [anchorDate, setDate] = useState(initial?.anchorDate ?? props.data.today);
  const [cadence, setCadence] = useState(initial?.cadence ?? "monthly");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const cents = parseAmountToCents(amount);
  const valid = Boolean(
    name.trim() &&
    name.trim().length <= 160 &&
    accountId &&
    categoryId &&
    cents !== null &&
    cents > 0 &&
    isCalendarDate(anchorDate)
  );
  const save = async () => {
    if (!props.tools || !valid || lock.current || blocked) return;
    lock.current = true;
    setBusy(true);
    try {
      const outcome = await props.tools.invoke("finance.bill.create", {
        id,
        name: name.trim(),
        accountId,
        categoryId,
        amountCents: cents!,
        anchorDate,
        cadence,
        ...review
      });
      if (outcome.status === "succeeded" && outcome.result.status === "ok") {
        invalidateQueries();
        props.onClose();
      } else if (outcome.status === "cancelled") setMessage("Cancelled. Your entries are kept.");
      else {
        setBlocked(true);
        setMessage(
          "The review changed or saving could not be confirmed. Your entries are kept. Close this form and check saved bills before trying again."
        );
      }
    } catch {
      setBlocked(true);
      setMessage("Saving could not be confirmed. Check saved bills before trying again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Add a bill"
      scrollBody
      closeLabel="Close"
      closeDisabled={busy}
      description={`Plan an expense in ${props.data.isoCurrency}`}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      footer={
        <div className="fnm-spread">
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || busy || blocked || !props.tools} onClick={() => void save()}>
            {busy ? "Saving…" : "Save bill plan"}
          </Button>
        </div>
      }
    >
      <div className="fnm-block">
        <label className="fnm-block fnm-block--tight">
          Bill name
          <input
            className="jds-input"
            aria-label="Bill name"
            maxLength={160}
            value={name}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) => setName(e.currentTarget.value)}
          />
        </label>
        <label className="fnm-block fnm-block--tight">
          Account
          <Select
            aria-label="Bill account"
            value={accountId}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) =>
              setAccount(e.currentTarget.value)
            }
          >
            <option value="">Choose an account</option>
            {props.data.accounts.map((a) => (
              <option value={a.accountId} key={a.accountId}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Category
          <Select
            aria-label="Bill category"
            value={categoryId}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) =>
              setCategory(e.currentTarget.value)
            }
          >
            <option value="">Choose a category</option>
            {props.data.categories.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Expected amount ({props.data.isoCurrency})
          <input
            className="jds-input"
            inputMode="decimal"
            value={amount}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) => setAmount(e.currentTarget.value)}
          />
        </label>
        <label className="fnm-block fnm-block--tight">
          First planned date
          <input
            className="jds-input"
            aria-label="First planned date"
            type="date"
            value={anchorDate}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) => setDate(e.currentTarget.value)}
          />
        </label>
        <label className="fnm-block fnm-block--tight">
          Repeats
          <Select
            aria-label="Bill repeats"
            value={cadence}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) =>
              setCadence(e.currentTarget.value)
            }
          >
            <option value="once">Once</option>
            <option value="weekly">Every week</option>
            <option value="fortnightly">Every two weeks</option>
            <option value="monthly">Every month</option>
            <option value="yearly">Every year</option>
          </Select>
        </label>
        {message ? <p role="alert">{message}</p> : null}
      </div>
    </Dialog>
  );
}
