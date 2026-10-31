import {
  Button,
  Dialog,
  Select,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { TransactionSplit } from "../domain/records";
import { centsToAmountInput, formatCents, parseAmountToCents } from "./format";

export interface SplitTransaction {
  id: string;
  accountId: string;
  date: string;
  name: string;
  amountCents: number;
  isoCurrency: string;
  categoryId: string | null;
  splits?: TransactionSplit[];
  splitRevision?: number;
  shared?: boolean;
}

/** Success is the committed tool result, never queue admission or an optimistic local edit. */
export async function saveSplit(
  row: SplitTransaction,
  parts: TransactionSplit[],
  tools?: ExternalModuleToolsHandleV1
): Promise<string | null> {
  if (!tools)
    return "This version of Moss cannot save splits from the page. Update Moss to continue; your entries are kept.";
  const outcome = await tools.invoke("finance.transaction.split", {
    transactionId: row.id,
    accountId: row.accountId,
    month: row.date.slice(0, 7),
    expectedAmountCents: row.amountCents,
    expectedCurrency: row.isoCurrency,
    expectedRevision: row.splitRevision ?? 0,
    categoryIds: parts.map((p) => p.categoryId),
    amountsCents: parts.map((p) => p.amountCents)
  });
  if (outcome.status === "succeeded" && outcome.result.status === "ok") return null;
  if (outcome.status === "cancelled") return "The split was cancelled. Your entries are kept.";
  if (outcome.status === "rejected") {
    if (outcome.moduleCode === "stale_transaction")
      return "The transaction amount, currency or allocation changed. Close this editor, refresh transactions, then review the split.";
    if (outcome.moduleCode === "storage_upgrade_required")
      return "Finance storage needs an update before you can save splits. Your entries are kept.";
    if (outcome.moduleCode === "pending_transaction")
      return "Wait until the transaction posts before splitting it.";
    if (outcome.moduleCode === "invalid_category")
      return "A category is no longer available. Refresh transactions and choose a current category.";
  }
  if (
    outcome.status === "invalid_input" ||
    (outcome.status === "rejected" && outcome.moduleCode === "split_total_mismatch")
  )
    return "Check the categories and amounts. Every cent must match the transaction total.";
  return "Saving could not be confirmed. Your entries are kept. Refresh transactions and check the result before retrying.";
}

export function SplitEditor(props: {
  transaction: SplitTransaction;
  tools?: ExternalModuleToolsHandleV1;
  categories: { id: string; name: string; archived?: boolean }[];
  onClose: () => void;
  onSaved: () => void;
}): ReactNodeLike {
  const tx = props.transaction;
  const [parts, setParts] = useState(() =>
    (tx.splits?.length
      ? tx.splits
      : [
          { categoryId: tx.categoryId ?? "", amountCents: tx.amountCents },
          { categoryId: "", amountCents: 0 }
        ]
    ).map((part) => ({ categoryId: part.categoryId, amount: centsToAmountInput(part.amountCents) }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = props.categories.filter((c) => !c.archived && c.id !== "transfers");
  const amounts = parts.map((p) => parseAmountToCents(p.amount));
  const total = amounts.reduce<number>((sum, cents) => sum + (cents ?? 0), 0);
  const valid =
    amounts.every((n) => n !== null) &&
    total === tx.amountCents &&
    parts.every((p) => live.some((c) => c.id === p.categoryId));
  const update = (index: number, changes: Partial<(typeof parts)[number]>): void => {
    setParts((previous) =>
      previous.map((part, at) => (at === index ? { ...part, ...changes } : part))
    );
    setError(null);
  };
  return (
    <Dialog
      title="Split transaction"
      description={`${tx.name} · ${formatCents(tx.amountCents, tx.isoCurrency)}`}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      dismissOnEscape={!busy}
      dismissOnBackdrop={!busy}
      closeLabel="Close split editor"
      closeDisabled={busy}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !valid}
            onClick={() => {
              setBusy(true);
              setError(null);
              void saveSplit(
                tx,
                parts.map((p, i) => ({ categoryId: p.categoryId, amountCents: amounts[i]! })),
                props.tools
              )
                .then((message) => {
                  setBusy(false);
                  if (message) setError(message);
                  else props.onSaved();
                })
                .catch(() => {
                  setBusy(false);
                  setError(
                    "Saving could not be confirmed. Your entries are kept; refresh before retrying."
                  );
                });
            }}
          >
            {busy ? "Confirming save…" : "Save split"}
          </Button>
        </>
      }
    >
      <div className="fnm-block fnm-block--tight">
        {parts.map((part, index) => (
          <div className="fnm-split-row" key={index}>
            <label className="fnm-block fnm-block--tight">
              Category {index + 1}
              <Select
                disabled={busy}
                aria-label={`Split category ${index + 1}`}
                value={part.categoryId}
                onChange={(event: { target: { value: string } }) =>
                  update(index, { categoryId: event.target.value })
                }
              >
                <option value="">Choose a category</option>
                {live.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="fnm-block fnm-block--tight">
              Amount ({tx.isoCurrency})
              <input
                className="jds-input"
                aria-label={`Split amount ${index + 1}`}
                inputMode="decimal"
                disabled={busy}
                value={part.amount}
                onChange={(event: { target: { value: string } }) =>
                  update(index, { amount: event.target.value })
                }
              />
            </label>
            <div className="fnm-split-action">
              <span aria-hidden="true">&nbsp;</span>
              <Button
                variant="link"
                aria-label={`Remove split ${index + 1}`}
                disabled={busy || parts.length === 1}
                onClick={() => setParts(parts.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        <div className="fnm-spread">
          <Button
            variant="secondary"
            disabled={busy || parts.length >= 20}
            onClick={() =>
              setParts([
                ...parts,
                { categoryId: "", amount: centsToAmountInput(tx.amountCents - total) }
              ])
            }
          >
            Add a part
          </Button>
          <strong role="status">
            {amounts.some((n) => n === null)
              ? "Enter valid amounts"
              : total === tx.amountCents
                ? "Every cent accounted for"
                : `${formatCents(tx.amountCents - total, tx.isoCurrency)} left to split`}
          </strong>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
