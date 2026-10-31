import {
  Badge,
  Button,
  Dialog,
  DisclosureToggle,
  Note,
  RowIndex,
  RowIndexItem,
  SectionHead,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { CardPaymentState } from "../domain/card-reserves";
import { centsToAmountInput, formatCents } from "./format";
import { parseLedgerAmount } from "./manual-entry";
import { invalidateQueries } from "./store";
export interface CardPaymentView extends CardPaymentState {
  name: string;
  archived: boolean;
}
export interface CardPaymentsView {
  month: string;
  currentMonth: string;
  isoCurrency: string;
  cardPayments: CardPaymentView[];
  cardChoices: { accountId: string; name: string }[];
}
export function CardPayments(props: {
  data: CardPaymentsView;
  disabled?: boolean;
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const [chosen, setChosen] = useState<{
    accountId: string;
    name: string;
    action: "enroll" | "fund";
    cash: number;
  } | null>(null);
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const d = props.data;
  if (!d.cardPayments.length && !d.cardChoices.length) return null;
  const disabled = props.disabled || !props.tools || d.month !== d.currentMonth;
  return (
    <section className="fnm-block fnm-block--tight" aria-label="Card payments">
      <SectionHead title="Card payments" rule />
      {d.month !== d.currentMonth ? (
        <Note variant="practical">
          Review payment cash in the current month. This month's saved accounting stays intact.
        </Note>
      ) : null}
      {d.cardPayments.map((c) => (
        <section key={c.accountId} className="fnm-block" aria-label={`${c.name} payment reserve`}>
          <div className="fnm-spread">
            <div className="fnm-inline">
              <strong>{c.name}</strong>
              {c.archived ? <Badge>Closed</Badge> : null}
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                setChosen({
                  accountId: c.accountId,
                  name: c.name,
                  action: "fund",
                  cash: Math.max(0, c.availableCents)
                })
              }
            >
              Review payment cash
            </Button>
          </div>
          <RowIndex variant="facts">
            <RowIndexItem
              title="Cash reserved"
              meta={formatCents(c.availableCents, d.isoCurrency)}
            />
            <RowIndexItem title="Card debt" meta={formatCents(c.owedCents, d.isoCurrency)} />
            <RowIndexItem
              title="Debt without cash backing"
              meta={formatCents(
                Math.max(0, c.owedCents - Math.max(0, c.availableCents)),
                d.isoCurrency
              )}
            />
          </RowIndex>
          <DisclosureToggle
            expanded={details[c.accountId] === true}
            className="fnm-disclosure-head"
            aria-label={`Payment activity for ${c.name}`}
            onClick={() =>
              setDetails((current) => ({ ...current, [c.accountId]: !current[c.accountId] }))
            }
          >
            Payment activity
            <span className="fnm-disclosure-marker" aria-hidden="true" />
          </DisclosureToggle>
          {details[c.accountId] ? (
            <RowIndex variant="facts">
              <RowIndexItem
                title="Funded purchases this month"
                meta={formatCents(c.fundedCents, d.isoCurrency)}
              />
              <RowIndexItem
                title="Refund movement this month"
                meta={formatCents(c.refundsCents, d.isoCurrency)}
              />
              <RowIndexItem
                title="Recorded payments this month"
                meta={formatCents(c.paymentsCents, d.isoCurrency)}
              />
            </RowIndex>
          ) : null}
          {c.availableCents < 0 ? (
            <Note variant="practical">
              Payment cash is overspent. Cover {formatCents(-c.availableCents, d.isoCurrency)}{" "}
              before funding targets.{" "}
              {c.archived ? "Reopen this card in Accounts to increase its payment cash." : ""}
            </Note>
          ) : null}
          {c.availableCents > c.owedCents ? (
            <Note variant="practical">
              {formatCents(c.availableCents - c.owedCents, d.isoCurrency)} more cash is reserved
              than this card currently owes. Review it to release excess cash.
            </Note>
          ) : null}
          {c.unfundedCents > 0 ? (
            <p className="jds-hint">
              {formatCents(c.unfundedCents, d.isoCurrency)} of this month's card purchases has no
              category funding.
            </p>
          ) : null}
        </section>
      ))}
      {d.cardChoices.map((c) => (
        <div key={c.accountId} className="fnm-spread">
          <strong>{c.name}</strong>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => setChosen({ ...c, action: "enroll", cash: 0 })}
          >
            Set up payment reserve
          </Button>
        </div>
      ))}
      {chosen ? (
        <PaymentDialog
          key={chosen.accountId}
          choice={chosen}
          data={d}
          tools={props.tools}
          onClose={() => setChosen(null)}
        />
      ) : null}
    </section>
  );
}
interface Preview extends Record<string, unknown> {
  revision: number;
  fingerprint: string;
  readyBeforeCents: number;
  readyAfterCents: number;
  payment: CardPaymentState;
}
function PaymentDialog(props: {
  choice: { accountId: string; name: string; action: "enroll" | "fund"; cash: number };
  data: CardPaymentsView;
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
}): ReactNodeLike {
  const [amount, setAmount] = useState(centsToAmountInput(props.choice.cash));
  const [review, setReview] = useState<{ input: Record<string, unknown>; preview: Preview } | null>(
    null
  );
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const d = props.data,
    enroll = props.choice.action === "enroll";
  const money = (cents: number) => formatCents(cents, d.isoCurrency);
  async function preview() {
    const cents = parseLedgerAmount(amount);
    if (cents === null || cents < 0) {
      setMessage("Enter a nonnegative amount with at most two decimal places.");
      return;
    }
    setBusy(true);
    setMessage(null);
    setReview(null);
    try {
      const input = {
        month: d.month,
        accountId: props.choice.accountId,
        action: props.choice.action,
        availableCents: cents
      };
      const result = await props.tools!.invoke("finance.card-reserve.preview", input);
      if (result.status !== "succeeded" || result.result.status !== "ok") {
        const code = result.status === "rejected" ? result.moduleCode : undefined;
        const errors: Record<string, string> = {
          insufficient_ready: "Choose less payment cash or release other assignments first.",
          card_ledger_review_required:
            "Review the card's unlinked transfers in Transactions. Use Record transfer in Accounts for complete payment pairs.",
          stale_budget: "The budget or ledger changed. Close this review and refresh Budget.",
          current_month_required: "Open the current budget month to review payment cash."
        };
        setMessage(
          code && errors[code]
            ? errors[code]!
            : "Could not review payment cash. Check the card ledger and refresh Budget."
        );
        return;
      }
      setReview({ input, preview: result.result as Preview });
    } catch {
      setMessage("Could not load the review. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!review) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.tools!.invoke("finance.card-reserve.save", {
        ...review.input,
        expectedRevision: review.preview.revision,
        expectedFingerprint: review.preview.fingerprint
      });
      if (result.status !== "succeeded" || result.result.status !== "ok") {
        if (result.status === "cancelled") {
          setMessage("Nothing saved. Your review is still here.");
          return;
        }
        setBlocked(true);
        setMessage(
          "The review changed or saving could not be confirmed. Close this review and refresh Budget to check saved records."
        );
        return;
      }
      invalidateQueries();
      props.onClose();
    } catch {
      setBlocked(true);
      setMessage(
        "The save outcome is uncertain. Close this review and refresh Budget to check saved records before trying again."
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      scrollBody
      title={enroll ? "Set up card-payment reserve" : "Review card-payment cash"}
      description={`${d.month} · ${d.isoCurrency}`}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      dismissOnEscape={!busy}
      dismissOnBackdrop={!busy}
      footer={
        <div className="fnm-spread">
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Close
          </Button>
          <Button variant="secondary" disabled={busy || blocked} onClick={() => void preview()}>
            Review amounts
          </Button>
          <Button disabled={!review || busy || blocked} onClick={() => void save()}>
            {busy ? "Please wait…" : "Confirm payment cash"}
          </Button>
        </div>
      }
    >
      <div className="fnm-block">
        <p>
          <strong>{props.choice.name}</strong>
        </p>
        <Note variant="practical">
          {enroll
            ? "Payment reserves stay active from this month; earlier months keep full-debt accounting. Funded purchases add category cash here. Starting debt needs separate cash."
            : "Choose the available cash you want reserved for payment. Increasing it uses Ready to assign; reducing it releases cash."}{" "}
          This never sends a payment.
        </Note>
        <label className="fnm-block fnm-block--tight">
          {enroll ? "Cash to assign for starting debt" : "Available payment cash"}
          <input
            className="jds-input"
            inputMode="decimal"
            value={amount}
            disabled={busy || blocked}
            onChange={(e) => {
              setAmount(e.currentTarget.value);
              setReview(null);
              setMessage(null);
            }}
          />
        </label>
        {review ? (
          <section className="fnm-block" aria-label="Payment cash preview">
            <SectionHead title="Review the money" rule />
            <RowIndex variant="facts">
              {[
                ["Payment cash after", review.preview.payment.availableCents],
                ["Ready after", review.preview.readyAfterCents],
                ["Ready before", review.preview.readyBeforeCents],
                ["Starting debt", review.preview.payment.startingDebtCents],
                ["Current card debt", review.preview.payment.owedCents],
                ["Funded purchases", review.preview.payment.fundedCents],
                ["Refund movement", review.preview.payment.refundsCents],
                ["Recorded payments", review.preview.payment.paymentsCents]
              ].map(([title, cents]) => (
                <RowIndexItem
                  key={String(title)}
                  title={String(title)}
                  meta={money(Number(cents))}
                />
              ))}
            </RowIndex>
            <p className="jds-hint">
              Cash funding goes to cash spending first. When multiple cards share an underfunded
              category, remaining cash is divided proportionally. Refunds can make payment cash
              negative.
            </p>
          </section>
        ) : null}
        {message ? <p role="alert">{message}</p> : null}
      </div>
    </Dialog>
  );
}
