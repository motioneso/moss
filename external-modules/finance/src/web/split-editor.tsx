import { Button, Dialog, Select, useState, type ReactNodeLike } from "@moss/module-web-sdk";
import type { TransactionSplit } from "../domain/records";
import { invokeTool, runWrite } from "./api";
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

function matches(row: SplitTransaction, parts: TransactionSplit[]): boolean {
  const actual = row.splits?.length
    ? row.splits
    : [{ categoryId: row.categoryId, amountCents: row.amountCents }];
  return JSON.stringify(actual) === JSON.stringify(parts);
}

/** Queue admission is not success: confirm the actual owner record before closing the editor. */
export async function saveSplit(
  row: SplitTransaction,
  parts: TransactionSplit[]
): Promise<string | null> {
  const outcome = await runWrite("finance.split-apply", "finance.split-apply", {
    transactionId: row.id,
    accountId: row.accountId,
    month: row.date.slice(0, 7),
    expectedAmountCents: row.amountCents,
    expectedCurrency: row.isoCurrency,
    expectedRevision: row.splitRevision ?? 0,
    categoryIds: parts.map((p) => p.categoryId),
    amountsCents: parts.map((p) => p.amountCents)
  });
  if (outcome.kind !== "queued")
    return "The split could not be queued. Your entries are kept; try again.";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await invokeTool<{ transactions?: SplitTransaction[] }>(
      "finance.transactions.query",
      {
        month: row.date.slice(0, 7),
        accountId: row.accountId,
        transactionId: row.id,
        limit: 1
      }
    );
    if (result.kind !== "ok") continue;
    const saved = result.result.transactions?.find((t) => t.id === row.id && !t.shared);
    if (!saved) continue;
    if (saved.amountCents !== row.amountCents)
      return "The bank amount changed. Close this editor, refresh transactions, then review the split.";
    if (saved.isoCurrency !== row.isoCurrency)
      return "The transaction currency changed. Close this editor, refresh transactions, then review the split.";
    if (matches(saved, parts)) return null;
    if ((saved.splitRevision ?? 0) !== (row.splitRevision ?? 0))
      return "Another edit changed this transaction. Close this editor and reopen the split before saving.";
  }
  return "Saving is not confirmed yet. Your entries are kept. Refresh transactions before retrying; the request may still complete.";
}

export function SplitEditor(props: {
  transaction: SplitTransaction;
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
                parts.map((p, i) => ({ categoryId: p.categoryId, amountCents: amounts[i]! }))
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
        <p>
          Divide this transaction between categories. Money out is positive; refunds and money in
          are negative. Keep one part to return to a single category.
        </p>
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
            <Button
              variant="link"
              aria-label={`Remove split ${index + 1}`}
              disabled={busy || parts.length === 1}
              onClick={() => setParts(parts.filter((_, at) => at !== index))}
            >
              Remove
            </Button>
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
