import {
  Button,
  Dialog,
  RowIndex,
  RowIndexItem,
  Textarea,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { TransactionSplit } from "../domain/records";
import { splitsBalance } from "../domain/splits";
import { formatCents } from "./format";
export interface DetailTransaction {
  id: string;
  name: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  categoryId: string | null;
  notes?: string;
  pending?: boolean;
  shared?: boolean;
  source?: "provider" | "manual";
  cleared?: boolean;
  reconciledAt?: string | null;
  reviewState?: "confirmed" | "needs_look";
  transferId?: string;
  splits?: TransactionSplit[];
}
export interface TransactionDetailsInput {
  row: DetailTransaction;
  accountName: string;
  categoryName: string;
  categories: { id: string; name: string }[];
}
export function captureTransactionDetails(props: TransactionDetailsInput) {
  return {
    row: { ...props.row, splits: props.row.splits?.map((p) => ({ ...p })) },
    account: props.accountName,
    category: props.categoryName,
    parts: (props.row.splits ?? []).map((p) => ({
      name: props.categories.find((c) => c.id === p.categoryId)?.name ?? "Archived category",
      amountCents: p.amountCents
    }))
  };
}
export type CapturedTransactionDetails = ReturnType<typeof captureTransactionDetails>;
export function TransactionDetails(props: {
  captured: CapturedTransactionDetails | null;
  onClose: () => void;
}): ReactNodeLike {
  const { captured } = props;
  const row = captured?.row;
  const notes = row?.shared ? null : (row?.notes ?? "");
  const status = row?.pending
    ? "Pending"
    : row?.source !== "manual"
      ? "Posted"
      : row.reconciledAt
        ? "Reconciled"
        : row.cleared
          ? "Cleared"
          : "Uncleared";
  return (
    <>
      {captured && row ? (
        <Dialog
          title="Transaction details"
          description={row.name}
          scrollBody
          onClose={props.onClose}
          closeLabel="Close transaction details"
          footer={
            <Button variant="secondary" onClick={props.onClose}>
              Back to register
            </Button>
          }
        >
          <div className="fnm-block">
            <strong className="fnm-amount">
              {row.amountCents < 0
                ? "Money in"
                : row.amountCents > 0
                  ? "Money out"
                  : "No money movement"}
              {" · "}
              {formatCents(Math.abs(row.amountCents), row.isoCurrency)}
            </strong>
            <p className="jds-hint">
              As read when you opened this transaction. Close and reload the register to check for
              changes.
            </p>
            {row.shared ? <p>Household · read only</p> : null}
            <RowIndex variant="facts">
              <RowIndexItem title="Date" meta={row.date} />
              <RowIndexItem title="Account" meta={captured.account} />
              <RowIndexItem title="Status" meta={status} />
              <RowIndexItem
                title="Category"
                meta={
                  row.transferId
                    ? "Linked transfer"
                    : captured.parts.length
                      ? "Split between categories"
                      : captured.category
                }
              />
              <RowIndexItem
                title="Review"
                meta={
                  row.shared
                    ? "Managed by owner"
                    : row.reviewState === "needs_look" ||
                        Boolean(row.splits?.length && !splitsBalance(row))
                      ? "Review needed"
                      : "Confirmed"
                }
              />
            </RowIndex>
            {captured.parts.length ? (
              <section className="fnm-block fnm-block--tight" aria-label="Split allocations">
                <strong>Split allocations</strong>
                <RowIndex variant="facts">
                  {captured.parts.map((part, index) => (
                    <RowIndexItem
                      key={index}
                      title={part.name}
                      meta={formatCents(part.amountCents, row.isoCurrency)}
                    />
                  ))}
                </RowIndex>
                <p className="jds-hint">
                  Allocations describe this transaction; the parent amount is counted once.
                </p>
              </section>
            ) : null}
            <section className="fnm-block fnm-block--tight" aria-label="Transaction note">
              <strong>Private note</strong>
              {notes === null ? (
                <p>Private notes are not shared.</p>
              ) : notes === "" ? (
                <p>No private note.</p>
              ) : (
                <Textarea aria-label="Private transaction note" readOnly value={notes} rows={5} />
              )}
            </section>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
