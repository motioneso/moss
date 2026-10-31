import { useReadCooldown } from "./read-cooldown";
import {
  Badge,
  Button,
  Dialog,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type {
  AccountCloseBlocker,
  AccountOperation,
  AccountReview
} from "../domain/account-lifecycle";
import { isDebtType } from "../domain/account-sign";
import { invokeTool } from "./api";
import { dayYearLabel, formatCents, instantDayLabel } from "./format";
import type { ManualAccountChoice } from "./manual-entry";
import { navigate } from "./router";
import { announce } from "./states";
const blockers: Record<AccountCloseBlocker, string> = {
  not_open: "The opening date is still in the future.",
  nonzero_balance: "Record the remaining money movements so the balance is zero.",
  invalid_ledger:
    "The recorded balance and original ledger do not agree. Review entries before closing.",
  future_entries: "Review future-dated entries before closing this ledger.",
  unreconciled:
    "Reconcile a zero statement through today. A pristine zero opening ledger needs no statement.",
  future_plans:
    "In Upcoming, reset later one-off changes and stop future plans that use this account before closing."
};
interface ReviewResult extends Record<string, unknown> {
  status: string;
  today?: string;
  account?: AccountReview;
}
export function ManualAccountManager(props: {
  accountId: string;
  tools?: ExternalModuleToolsHandleV1;
  returnFocusRef?: { current: HTMLElement | null };
  onClose: () => void;
  onSaved: () => void;
  onReconcile: (account: ManualAccountChoice) => void;
}): ReactNodeLike {
  const [review, setReview] = useState<AccountReview | null>(null);
  const [mode, setMode] = useState<"details" | AccountOperation>("details"),
    [name, setName] = useState("");
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const cooldown = useReadCooldown();
  const generation = useRef(0),
    touched = useRef(false),
    pending = useRef(false);
  const read = async () => {
    const token = ++generation.current;
    setLoading(true);
    setMessage(null);
    const outcome = await invokeTool<ReviewResult>("finance.manual.account-review", {
      accountId: props.accountId
    });
    if (token !== generation.current) return;
    setLoading(false);
    if (outcome.kind === "ok" && outcome.result.status === "ok" && outcome.result.account) {
      setReview(outcome.result.account);
      setBlocked(false);
      setMode("details");
      if (!touched.current) setName(outcome.result.account.name);
    } else {
      setBlocked(true);
      if (outcome.kind === "error" && outcome.retryAfterSeconds)
        cooldown.wait(outcome.retryAfterSeconds);
      setMessage(
        outcome.kind === "error" && outcome.retryAfterSeconds
          ? outcome.message
          : outcome.kind === "ok" && outcome.result.status === "storage_update_required"
            ? "Update Finance storage before managing manual accounts."
            : "The saved manual account could not be read. Your draft is kept; check your connection and review again."
      );
    }
  };
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
    };
  }, []);
  const save = async (operation: AccountOperation) => {
    if (!review || !props.tools || blocked || loading || pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools.invoke("finance.manual.account-update", {
        accountId: review.accountId,
        expectedRevision: review.revision,
        operation,
        ...(operation === "rename" ? { name: name.trim() } : {})
      });
      if (result.status === "succeeded" && result.result.status === "ok") {
        announce(
          operation === "rename"
            ? "Account name saved."
            : operation === "close"
              ? "Manual account closed. Its history is kept."
              : "Manual account reopened. Reconciled periods stay locked."
        );
        props.onSaved();
        return;
      }
      if (result.status === "cancelled")
        setMessage("Cancelled. Your account review and draft are kept.");
      else {
        setBlocked(true);
        setMessage(
          result.status === "rejected" && result.moduleCode === "account_changed"
            ? "This account or its dependencies changed. No account update was saved. Review its saved state before trying again."
            : "Saving could not be confirmed. Your draft is kept. Review the saved account before trying again."
        );
      }
    } catch {
      setBlocked(true);
      setMessage(
        "Saving could not be confirmed. Your draft is kept. Review the saved account before trying again."
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const ready = Boolean(review) && !loading && !busy && !blocked && Boolean(props.tools);
  const history = () => {
    if (!review) return;
    const month = (review.lastEntryDate ?? review.openingDate).slice(0, 7);
    navigate(
      `/transactions?${new URLSearchParams({ accountId: review.accountId, month, scope: "own" })}`
    );
  };
  return (
    <Dialog
      title="Manage manual account"
      description={review?.name ?? "Read your saved ledger before making changes"}
      scrollBody
      returnFocusRef={props.returnFocusRef}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      closeDisabled={busy}
      dismissOnEscape={!busy}
      dismissOnBackdrop={!busy}
      closeLabel="Close account management"
      footer={
        <>
          {mode !== "details" ? (
            <Button variant="secondary" disabled={busy} onClick={() => setMode("details")}>
              Back to account
            </Button>
          ) : null}
          {mode === "rename" ? (
            <Button
              disabled={!ready || !name.trim() || name.trim().length > 80}
              onClick={() => void save("rename")}
            >
              {busy ? "Saving name…" : "Save account name"}
            </Button>
          ) : null}
          {mode === "close" ? (
            <Button disabled={!ready || !review?.canClose} onClick={() => void save("close")}>
              {busy ? "Closing ledger…" : "Close in Moss"}
            </Button>
          ) : null}
          {mode === "reopen" ? (
            <Button disabled={!ready} onClick={() => void save("reopen")}>
              {busy ? "Reopening ledger…" : "Reopen manual account"}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="fnm-block fnm-block--tight fnm-account-management">
        {loading ? <p role="status">Reading saved account…</p> : null}
        {message ? <p role="status">{message}</p> : null}
        {blocked || !review ? (
          <Button
            variant="secondary"
            disabled={busy || loading || cooldown.cooling}
            onClick={() => void read()}
          >
            Review saved account
          </Button>
        ) : null}
        {review ? (
          <>
            <div className="fnm-spread">
              <strong>
                {formatCents(review.balanceCents, review.isoCurrency)} {review.isoCurrency}
              </strong>
              <Badge>{review.archivedAt ? "Closed" : "Active"}</Badge>
            </div>
            <p className="jds-hint">
              {isDebtType(review.type) ? "Amount owed" : "Balance"} · observed{" "}
              {instantDayLabel(review.balanceAsOf)}. Opening{" "}
              {formatCents(review.openingBalanceCents, review.isoCurrency)} on{" "}
              {dayYearLabel(review.openingDate, "short")}.
            </p>
            {mode === "details" ? (
              <>
                <div className="fnm-chips">
                  <Button variant="secondary" disabled={!ready} onClick={() => setMode("rename")}>
                    Rename account
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!ready}
                    onClick={() => setMode(review.archivedAt ? "reopen" : "close")}
                  >
                    {review.archivedAt ? "Review reopening" : "Review closing"}
                  </Button>
                  <Button variant="link" disabled={busy || loading} onClick={history}>
                    View account history
                  </Button>
                </div>
              </>
            ) : null}
            {mode === "rename" ? (
              <label className="fnm-block fnm-block--tight">
                Account name
                <input
                  className="jds-input"
                  value={name}
                  maxLength={80}
                  disabled={busy || loading}
                  autoComplete="off"
                  onChange={(event) => {
                    touched.current = true;
                    setName(event.currentTarget.value);
                  }}
                />
              </label>
            ) : null}
            {mode === "close" ? (
              <>
                {review.blockers.length ? (
                  <ul>
                    {review.blockers.map((reason) => (
                      <li key={reason}>{blockers[reason]}</li>
                    ))}
                  </ul>
                ) : (
                  <p role="status">The saved ledger is ready to close.</p>
                )}
                {review.blockers.includes("unreconciled") ||
                review.blockers.includes("nonzero_balance") ? (
                  <Button
                    variant="link"
                    disabled={busy || loading}
                    onClick={() => props.onReconcile(review)}
                  >
                    Reconcile this account
                  </Button>
                ) : null}
                {review.futurePlanCount > 0 ? (
                  <>
                    <p>{review.futurePlanCount} plans still reference this account beyond today.</p>
                    <Button
                      variant="link"
                      disabled={busy || loading}
                      onClick={() => navigate("/upcoming")}
                    >
                      Review Upcoming bills
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
            {mode === "reopen" && review.lastReconciledDate ? (
              <p className="jds-hint">
                Last reconciled statement: {dayYearLabel(review.lastReconciledDate, "short")}.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
