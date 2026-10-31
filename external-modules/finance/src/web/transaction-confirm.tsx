import {
  Button,
  Dialog,
  Note,
  RowIndex,
  RowIndexItem,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { formatCents } from "./format";
import { announce } from "./states";
export interface ConfirmRow {
  id: string;
  writeRevision?: string;
  name: string;
  date: string;
  categoryId: string | null;
  categoryName?: string;
  amountCents: number;
  isoCurrency: string;
}
export function TransactionConfirm(props: {
  rows: readonly ConfirmRow[];
  categories: { id: string; name: string }[];
  tools?: ExternalModuleToolsHandleV1;
  readVersion: object | null;
  readSnapshot: object;
  readFailed: boolean;
  onReload: () => void;
  onSaved: (ids: string[]) => void;
}): ReactNodeLike {
  const [captured, setCaptured] = useState<ConfirmRow[] | null>(null);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false),
    beforeRead = useRef<object | null>(null);
  useEffect(() => {
    if (!checking || props.readSnapshot === beforeRead.current) return;
    if (props.readVersion) {
      setChecking(false);
      setBlocked(false);
      setCaptured(null);
      setOpen(false);
      setMessage(null);
    } else if (props.readFailed) setChecking(false);
  }, [checking, props.readVersion, props.readSnapshot, props.readFailed]);
  const save = async () => {
    if (!props.tools || !captured || pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools.invoke("finance.transactions.confirm", {
        rows: captured.map((r) => ({ id: r.id, writeRevision: r.writeRevision! }))
      });
      if (result.status === "succeeded" && result.result.status === "ok") {
        announce(`Confirmed ${captured.length} transaction categories.`);
        props.onSaved(captured.map((r) => r.id));
        setCaptured(null);
        setOpen(false);
      } else if (result.status === "cancelled")
        setMessage("Cancelled. Your captured review is kept; nothing was confirmed.");
      else {
        setBlocked(true);
        setMessage(
          result.status === "rejected" && result.moduleCode === "stale_transactions"
            ? "A reviewed transaction or category changed. Nothing was confirmed. Close this review and check saved records."
            : "Confirmation could not be verified. Your captured review is kept. Close this review and check saved records before trying again."
        );
      }
    } catch {
      setBlocked(true);
      setMessage(
        "Confirmation could not be verified. Your captured review is kept. Close this review and check saved records before trying again."
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {props.rows.length ? (
        <Button
          variant="secondary"
          disabled={busy || blocked || !props.tools}
          onClick={() => {
            setCaptured(
              props.rows.slice(0, 200).map((r) => ({
                ...r,
                categoryName:
                  props.categories.find((c) => c.id === r.categoryId)?.name ??
                  r.categoryId ??
                  "Uncategorized"
              }))
            );
            setMessage(null);
            setOpen(true);
          }}
        >
          Review {Math.min(props.rows.length, 200)}{" "}
          {props.rows.length === 1 ? "category" : "categories"}
        </Button>
      ) : null}
      {props.rows.length > 200 ? (
        <span className="jds-hint">
          First 200 of {props.rows.length} loaded reviews; the rest stay for the next batch.
        </span>
      ) : null}
      {blocked && !open ? (
        <Note variant="practical">
          Your captured review is kept. Check the saved register before submitting another batch.
          <Button
            variant="link"
            disabled={checking}
            onClick={() => {
              beforeRead.current = props.readSnapshot;
              setChecking(true);
              props.onReload();
            }}
          >
            {checking ? "Checking saved records…" : "Check saved records"}
          </Button>
          {props.readFailed ? (
            <p role="status">
              The register could not be refreshed. Try checking again; no confirmation has been
              assumed.
            </p>
          ) : null}
        </Note>
      ) : null}
      {open && captured ? (
        <Dialog
          title="Review transaction categories"
          description={`${captured.length} captured transactions · existing categories`}
          scrollBody
          closeLabel="Close confirmation review"
          closeDisabled={busy}
          dismissOnEscape={!busy}
          dismissOnBackdrop={!busy}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Back to register
              </Button>
              <Button disabled={busy || blocked} onClick={() => void save()}>
                {busy ? "Confirming categories…" : "Confirm reviewed categories"}
              </Button>
            </>
          }
        >
          <div className="fnm-block">
            <p>
              Confirm these existing categories together. Amounts, notes, splits and statement
              records stay unchanged. No merchant rule is created.
            </p>
            <RowIndex density="compact">
              {captured.map((r) => (
                <RowIndexItem
                  key={r.id}
                  title={r.name}
                  excerpt={`${r.date} · ${r.categoryName ?? r.categoryId}`}
                  meta={`${r.amountCents < 0 ? "Inflow" : "Outflow"} ${formatCents(Math.abs(r.amountCents), r.isoCurrency)}`}
                />
              ))}
            </RowIndex>
            {message ? <p role="status">{message}</p> : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
