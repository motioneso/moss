import {
  Button,
  Dialog,
  Note,
  RowIndex,
  RowIndexItem,
  Select,
  SelectionBar,
  useState,
  useRef,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { formatCents } from "./format";
import { announce } from "./states";
import { invalidateQueries } from "./store";
export interface BulkRow {
  id: string;
  writeRevision?: string;
  name: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  shared?: boolean;
  transferId?: string;
  pending?: boolean;
  splits?: readonly unknown[];
}
/** Most rows one bulk change may carry. */
export const BULK_LIMIT = 200;
export const bulkEligible = (row: BulkRow) =>
  !row.transferId &&
  !row.shared &&
  !row.pending &&
  !row.splits?.length &&
  Boolean(row.writeRevision);
/** Renders only while rows are selected or a saved result needs a check. */
export function TransactionBulkBar(props: {
  selected: readonly BulkRow[];
  loaded: readonly BulkRow[];
  categories: { id: string; name: string; archived?: boolean }[];
  tools?: ExternalModuleToolsHandleV1;
  onLoaded: () => void;
  onClear: () => void;
  onSaved: () => void;
  onLockChange: (locked: boolean) => void;
}): ReactNodeLike {
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  if (props.selected.length === 0 && !uncertain && !open) return null;
  const full = props.selected.length >= BULK_LIMIT;
  const unselected = props.loaded.filter(
    (row) => bulkEligible(row) && !props.selected.some((picked) => picked.id === row.id)
  );
  return (
    <SelectionBar aria-label="Selected transactions">
      <div className="fnm-chips">
        <strong role="status" className="fnm-amount">
          {props.selected.length} selected{full ? " · limit reached" : ""}
        </strong>
        {unselected.length > 0 && !full ? (
          <Button size="sm" variant="link" disabled={uncertain} onClick={props.onLoaded}>
            Select editable rows
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="link"
          disabled={!props.selected.length || uncertain}
          onClick={props.onClear}
        >
          Clear selection
        </Button>
      </div>
      <div className="fnm-chips">
        <Select
          aria-label="Category for selected transactions"
          value={category}
          disabled={uncertain}
          onChange={(e) => setCategory(e.currentTarget.value)}
        >
          <option value="">Choose a category</option>
          {props.categories
            .filter((c) => !c.archived && c.id !== "transfers")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
        <Button
          size="sm"
          disabled={!props.tools || !props.selected.length || !category || uncertain}
          onClick={() => setOpen(true)}
        >
          Review category change
        </Button>
      </div>
      {uncertain ? (
        <Note variant="practical">
          Check the saved register before making a new selection. Your previous choices are kept.
          <Button
            variant="link"
            onClick={() => {
              invalidateQueries();
              setUncertain(false);
              props.onLockChange(false);
              props.onClear();
            }}
          >
            Check saved records and clear review
          </Button>
        </Note>
      ) : null}
      {open ? (
        <BulkCategoryDialog
          rows={props.selected}
          category={{
            id: category,
            name: props.categories.find((c) => c.id === category)?.name ?? category
          }}
          tools={props.tools}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            props.onSaved();
          }}
          onUncertain={() => {
            setUncertain(true);
            props.onLockChange(true);
          }}
        />
      ) : null}
    </SelectionBar>
  );
}
export function BulkCategoryDialog(props: {
  rows: readonly BulkRow[];
  category: { id: string; name: string };
  previousCategory?: string;
  confirmOnly?: boolean;
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
  onSaved: () => void;
  onUncertain: () => void;
}): ReactNodeLike {
  const [previousCategory] = useState(props.previousCategory);
  const [confirmOnly] = useState(props.confirmOnly === true);
  const individual = previousCategory !== undefined;
  const [rows] = useState(() => props.rows.map((r) => ({ ...r })));
  const [category] = useState(props.category);
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const save = async () => {
    if (!props.tools || inFlight.current || blocked) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const references = rows.map((r) => ({ id: r.id, writeRevision: r.writeRevision! }));
      const result = confirmOnly
        ? await props.tools.invoke("finance.transactions.confirm", { rows: references })
        : await props.tools.invoke("finance.transactions.bulk-category", {
            categoryId: category.id,
            rows: references
          });
      if (result.status === "succeeded" && result.result.status === "ok") {
        announce(
          confirmOnly
            ? "Category confirmed."
            : rows.length === 1
              ? "Category changed."
              : `Changed the category for ${rows.length} transactions.`
        );
        invalidateQueries();
        props.onSaved();
        return;
      }
      if (result.status === "cancelled")
        setMessage("Cancelled. Your selection and category are kept.");
      else if (result.status === "rejected") {
        if (result.moduleCode === "stale_transactions") {
          setBlocked(true);
          props.onUncertain();
        }
        setMessage(
          result.moduleCode === "stale_transactions"
            ? "A selected record changed. Nothing was saved. Close this review and check saved records before choosing again."
            : "The change was refused. Your selection and category are kept; check that every record and category is still available."
        );
      } else {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          "Saving could not be confirmed. Close this review and check saved records before trying again."
        );
      }
    } catch {
      setBlocked(true);
      props.onUncertain();
      setMessage(
        "Saving could not be confirmed. Close this review and check saved records before trying again."
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={
        confirmOnly
          ? "Review transaction category"
          : individual
            ? "Review category change"
            : "Review selected transactions"
      }
      description={
        confirmOnly
          ? `Existing category · ${category.name}`
          : rows.length === 1
            ? `${previousCategory ?? "Current category"} → ${category.name}`
            : `${rows.length} transactions → ${category.name}`
      }
      scrollBody
      onClose={() => {
        if (!inFlight.current) props.onClose();
      }}
      closeLabel="Close category review"
      closeDisabled={busy}
      dismissOnEscape={!busy}
      dismissOnBackdrop={!busy}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (!inFlight.current) props.onClose();
            }}
          >
            {individual ? "Back to transactions" : "Back to selection"}
          </Button>
          <Button disabled={busy || blocked} onClick={() => void save()}>
            {busy
              ? "Confirming change…"
              : confirmOnly
                ? "Confirm category"
                : "Confirm category change"}
          </Button>
        </>
      }
    >
      <div className="fnm-block">
        <p>
          {confirmOnly
            ? `Confirm ${category.name} as reviewed.`
            : `${individual ? "Change this category" : "Change all selected categories"} to ${category.name}.`}{" "}
          Amounts, dates, notes and reconciliation stay unchanged. No merchant rule is created.
        </p>
        <RowIndex density="compact">
          {rows.map((row) => (
            <RowIndexItem
              key={row.id}
              title={row.name}
              excerpt={row.date}
              meta={
                row.amountCents < 0
                  ? `+${formatCents(-row.amountCents, row.isoCurrency)}`
                  : formatCents(row.amountCents, row.isoCurrency)
              }
            />
          ))}
        </RowIndex>
        {message ? <p role="status">{message}</p> : null}
      </div>
    </Dialog>
  );
}
