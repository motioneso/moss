import {
  Button,
  RowIndex,
  RowIndexItem,
  SectionHead,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { SuggestedCadence } from "../domain/bill-suggestions";
import { cadenceText, formatCents, shortDayLabel } from "./format";
import { invalidateQueries } from "./store";

export interface BillSuggestionView {
  accountId: string;
  accountName: string | null;
  payeeKey: string;
  name: string;
  cadence: SuggestedCadence;
  amountCents: number;
  categoryId: string | null;
  lastDate: string;
  nextDate: string;
}

export interface BillSuggestionsResult extends Record<string, unknown> {
  setupRequired?: boolean;
  isoCurrency?: string;
  suggestions?: BillSuggestionView[];
}

export const suggestionKey = (s: BillSuggestionView) =>
  `${s.accountId}:${s.payeeKey}:${s.cadence}:${s.amountCents}`;

export function BillSuggestions(props: {
  suggestions: readonly BillSuggestionView[];
  isoCurrency: string;
  disabled: boolean;
  tools?: ExternalModuleToolsHandleV1;
  onAdd: (s: BillSuggestionView) => void;
  actions?: ReactNodeLike;
}): ReactNodeLike {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  const dismiss = async (s: BillSuggestionView) => {
    if (!props.tools || lock.current) return;
    lock.current = true;
    setBusy(suggestionKey(s));
    setMessage(null);
    try {
      const outcome = await props.tools.invoke("finance.bills.suggestions.dismiss", {
        accountId: s.accountId,
        payeeKey: s.payeeKey,
        cadence: s.cadence,
        amountCents: s.amountCents
      });
      if (outcome.status === "succeeded" && outcome.result.status === "ok") invalidateQueries();
      else if (outcome.status !== "cancelled") setMessage(`${s.name} could not be dismissed.`);
    } catch {
      setMessage(`${s.name} could not be dismissed.`);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  return (
    <section className="fnm-block fnm-block--tight" aria-label="Suggested bills">
      <SectionHead title="Suggested bills" meta={props.actions} rule />
      {message ? <p role="status">{message}</p> : null}
      <RowIndex density="compact">
        {props.suggestions.map((s) => (
          <RowIndexItem
            key={suggestionKey(s)}
            title={s.name}
            excerpt={[
              cadenceText(s.cadence),
              `last charged ${shortDayLabel(s.lastDate)}`,
              s.accountName
            ]
              .filter(Boolean)
              .join(" · ")}
            meta={
              <div className="fnm-spread">
                <strong>{formatCents(s.amountCents, props.isoCurrency)}</strong>
                <div className="fnm-chips">
                  <Button
                    size="sm"
                    disabled={props.disabled || busy !== null || !props.tools}
                    aria-label={`Add as bill, ${s.name}`}
                    onClick={() => props.onAdd(s)}
                  >
                    Add as bill
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={props.disabled || busy !== null || !props.tools}
                    aria-label={`Dismiss ${s.name}`}
                    onClick={() => void dismiss(s)}
                  >
                    {busy === suggestionKey(s) ? "Dismissing…" : "Dismiss"}
                  </Button>
                </div>
              </div>
            }
          />
        ))}
      </RowIndex>
    </section>
  );
}
