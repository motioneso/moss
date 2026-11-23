// external-modules/finance/src/web/assign-ready-dialog.tsx
//
// Assign with no targets set: pick a category and an amount, prefilled with all of Ready to
// assign. The money moves with the same reviewed move the category panel uses.
import {
  Button,
  Dialog,
  Field,
  FormLabel,
  Select,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { centsToAmountInput, formatCents, parseAmountToCents } from "./format";
import { announce } from "./states";
import { invalidateQueries } from "./store";

export function AssignReadyDialog(props: {
  month: string;
  currency: string;
  readyCents: number;
  revision: number;
  fingerprint: string;
  categories: { id: string; name: string }[];
  tools?: ExternalModuleToolsHandleV1;
  onUncertain: () => void;
  onClose: () => void;
}): ReactNodeLike {
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState(centsToAmountInput(props.readyCents));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const cents = parseAmountToCents(amount);
  const valid = cents !== null && cents > 0 && cents <= props.readyCents && categoryId !== "";
  const save = async () => {
    if (!valid || !props.tools || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await props.tools.invoke("finance.budget.move", {
        month: props.month,
        fromCategoryId: "ready_to_assign",
        toCategoryId: categoryId,
        amountCents: cents,
        expectedRevision: props.revision,
        expectedFingerprint: props.fingerprint
      });
      if (!alive.current) return;
      if (outcome.status === "succeeded" && outcome.result.status === "ok") {
        announce(`Assigned ${formatCents(cents!, props.currency)}.`);
        invalidateQueries();
        props.onClose();
      } else if (outcome.status === "cancelled") setMessage("Cancelled. Nothing was assigned.");
      else {
        setMessage("Not assigned. Check saved records, then try again.");
        props.onUncertain();
      }
    } catch {
      if (alive.current) {
        setMessage("Not assigned. Check saved records, then try again.");
        props.onUncertain();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Dialog
      title="Assign"
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
          <Button disabled={!valid || busy || !props.tools} onClick={() => void save()}>
            {busy ? "Saving…" : "Assign"}
          </Button>
        </div>
      }
    >
      <div className="fnm-block fnm-block--tight">
        <Field>
          <FormLabel htmlFor="fnm-assign-category">Category</FormLabel>
          <Select
            id="fnm-assign-category"
            value={categoryId}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) =>
              setCategoryId(e.currentTarget.value)
            }
          >
            <option value="">Choose a category</option>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FormLabel htmlFor="fnm-assign-amount">Amount</FormLabel>
          <input
            id="fnm-assign-amount"
            className="jds-input"
            inputMode="decimal"
            value={amount}
            disabled={busy}
            onChange={(e: { currentTarget: { value: string } }) => setAmount(e.currentTarget.value)}
          />
        </Field>
        {message ? <p role="alert">{message}</p> : null}
      </div>
    </Dialog>
  );
}
