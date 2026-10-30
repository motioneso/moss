import { useReadCooldown } from "./read-cooldown";
import {
  Button,
  Dialog,
  Note,
  RowIndex,
  RowIndexItem,
  Select,
  Switch,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { MerchantRule } from "../domain/merchant-rules";
import type { RuleCategory, RulePreview } from "./merchant-rule-types";
import { invokeTool } from "./api";
import { currentMonth, formatCents } from "./format";
import { announce } from "./states";
export function MerchantRuleDialog(props: {
  rule: MerchantRule | null;
  categories: readonly RuleCategory[];
  tools?: ExternalModuleToolsHandleV1;
  onClose: () => void;
  onSaved: () => void;
  onUncertain: () => void;
}): ReactNodeLike {
  const cooldown = useReadCooldown();
  const [original] = useState(props.rule),
    [tools] = useState(props.tools);
  const [merchant, setMerchant] = useState(original?.payeeKey ?? "");
  const [categoryId, setCategory] = useState(original?.categoryId ?? "");
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [month, setMonth] = useState(currentMonth());
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewing, setPreviewing] = useState(false),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [captured, setCaptured] = useState<{
    merchant: string;
    categoryId: string;
    categoryName: string;
    enabled: boolean;
    payeeKey: string;
  } | null>(null);
  const inFlight = useRef(false),
    reading = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const category = props.categories.find((c) => c.id === categoryId);
  const categoryValid = Boolean(
    category && (!category.archived || (!enabled && original?.categoryId === categoryId))
  );
  const duplicate = !original && preview?.existing;
  const valid =
    merchant.trim().length > 0 &&
    new TextEncoder().encode(merchant.trim()).byteLength <= 200 &&
    categoryValid &&
    preview &&
    !duplicate;
  const loadPreview = async () => {
    if (reading.current || inFlight.current || blocked || cooldown.cooling || !merchant.trim())
      return;
    reading.current = true;
    setPreviewing(true);
    setMessage(null);
    const result = await invokeTool<RulePreview>("finance.rules.preview", {
      merchant: merchant.trim(),
      month
    }).catch(() => ({
      kind: "error" as const,
      message: "Matching history could not be loaded. Try the preview again."
    }));
    if (!alive.current) return;
    reading.current = false;
    setPreviewing(false);
    if (result.kind === "error" && "retryAfterSeconds" in result && result.retryAfterSeconds)
      cooldown.wait(result.retryAfterSeconds);
    if (result.kind === "ok") setPreview(result.result);
    else {
      setPreview(null);
      setMessage(
        result.kind === "error"
          ? result.message
          : "Matching history could not be loaded. Try the preview again."
      );
    }
  };
  const save = async () => {
    if (!tools || !captured || inFlight.current || blocked) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await tools.invoke("finance.rules.update", {
        merchant: captured.merchant,
        categoryId: captured.categoryId,
        enabled: captured.enabled,
        ...(original ? { expectedRevision: original.writeRevision } : {})
      });
      if (!alive.current) return;
      if (result.status === "succeeded" && result.result.status === "ok") {
        announce(captured.enabled ? "Merchant rule saved." : "Merchant rule disabled.");
        props.onSaved();
        return;
      }
      if (result.status === "cancelled")
        setMessage("Cancelled. Your captured rule review is kept.");
      else {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          result.status === "rejected" && result.moduleCode === "stale_rules"
            ? "The rule or category changed. Nothing was saved. Close this review and check saved rules before choosing again."
            : "Saving could not be confirmed. Your entries are kept here. Close this review and check saved rules before trying again."
        );
      }
    } catch {
      if (alive.current) {
        setBlocked(true);
        props.onUncertain();
        setMessage(
          "Saving could not be confirmed. Your entries are kept here. Close this review and check saved rules before trying again."
        );
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const close = () => {
    if (!inFlight.current && !reading.current) props.onClose();
  };
  return (
    <Dialog
      title={
        captured ? "Review merchant rule" : original ? "Edit merchant rule" : "Add merchant rule"
      }
      description={
        captured
          ? `${captured.payeeKey} · ${captured.enabled ? captured.categoryName : "Disabled"}`
          : "One normalized merchant match · future arrivals only"
      }
      scrollBody
      onClose={close}
      closeLabel="Close merchant rule"
      closeDisabled={busy || previewing}
      dismissOnEscape={!busy && !previewing}
      dismissOnBackdrop={!busy && !previewing}
      footer={
        <>
          <Button variant="secondary" disabled={busy || previewing} onClick={close}>
            Back to rules
          </Button>
          {captured ? (
            <>
              <Button
                variant="link"
                disabled={busy || blocked}
                onClick={() => {
                  if (!inFlight.current) {
                    setCaptured(null);
                    setMessage(null);
                  }
                }}
              >
                Edit details
              </Button>
              <Button disabled={busy || blocked || !tools} onClick={() => void save()}>
                {busy ? "Confirming rule…" : "Confirm rule"}
              </Button>
            </>
          ) : (
            <Button
              disabled={!valid || busy || previewing || blocked || !tools}
              onClick={() => {
                if (valid && preview) {
                  setMessage(null);
                  setCaptured({
                    merchant: merchant.trim(),
                    categoryId,
                    categoryName: category!.name,
                    enabled,
                    payeeKey: preview.payeeKey
                  });
                }
              }}
            >
              Review rule
            </Button>
          )}
        </>
      }
    >
      <div className="fnm-manual-form">
        <Note variant="practical">
          Rules apply to future uncategorized arrivals. Existing transactions and user categories
          stay unchanged. No payment is made.
        </Note>
        {captured ? (
          <>
            <p>
              Match the complete normalized merchant <strong>{captured.payeeKey}</strong>.{" "}
              {captured.enabled
                ? `Use ${captured.categoryName} for new uncategorized arrivals.`
                : "Stop this rule from assigning future categories. Its saved configuration and history remain."}
            </p>
            {original ? (
              <p className="jds-hint">
                Previously:{" "}
                {props.categories.find((c) => c.id === original.categoryId)?.name ??
                  "Unavailable category"}{" "}
                · {original.enabled ? "Enabled" : "Disabled"}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <label className="fnm-block fnm-block--tight">
              Merchant match
              <input
                className="jds-input"
                aria-label="Merchant match"
                maxLength={200}
                value={merchant}
                disabled={Boolean(original) || previewing || blocked}
                onChange={(e) => {
                  setMerchant(e.currentTarget.value);
                  setPreview(null);
                  setMessage(null);
                }}
              />
            </label>
            <p className="jds-hint">
              Matching ignores case, digits and punctuation, and combines spaces. Preview the
              normalized name before saving. To change an existing match, add a separate rule.
            </p>
            <label className="fnm-block fnm-block--tight">
              Category
              <Select
                aria-label="Rule category"
                value={categoryId}
                disabled={blocked}
                onChange={(e) => setCategory(e.currentTarget.value)}
              >
                <option value="">Choose a category</option>
                {props.categories
                  .filter((c) => !c.archived || c.id === original?.categoryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.archived ? " (archived)" : ""}
                    </option>
                  ))}
              </Select>
            </label>
            <Switch
              ariaLabel="Enable merchant rule"
              label="Use this rule for future arrivals"
              checked={enabled}
              disabled={blocked}
              onChange={setEnabled}
            />
            {category?.archived && enabled ? (
              <p role="status">Choose a live category to enable this rule, or turn it off.</p>
            ) : null}
            <div className="fnm-block fnm-block--tight">
              <label className="fnm-block fnm-block--tight">
                Preview month
                <input
                  className="jds-input"
                  type="month"
                  aria-label="Rule preview month"
                  value={month}
                  disabled={previewing || blocked}
                  onChange={(e) => {
                    setMonth(e.currentTarget.value);
                    setPreview(null);
                  }}
                />
              </label>
              <Button
                variant="secondary"
                disabled={!merchant.trim() || previewing || blocked || cooldown.cooling}
                onClick={() => void loadPreview()}
              >
                {previewing
                  ? "Loading matches…"
                  : cooldown.cooling
                    ? "Wait before previewing"
                    : "Preview matching history"}
              </Button>
            </div>
            {preview ? (
              <div className="fnm-block fnm-block--tight">
                <p>
                  <strong>Normalized match: {preview.payeeKey}</strong>
                </p>
                {duplicate ? (
                  <p role="status">
                    This merchant already has a rule. Close this form and edit its saved rule.
                  </p>
                ) : null}
                <p className="jds-hint">
                  {preview.examples.length} of {preview.total} matching transactions in{" "}
                  {preview.month}. These examples stay unchanged; this is not retroactive
                  application.
                </p>
                {preview.examples.length ? (
                  <RowIndex density="compact">
                    {preview.examples.map((r) => (
                      <RowIndexItem
                        key={r.id}
                        title={r.name}
                        excerpt={`${r.date} · ${r.categoryName}${r.alreadyCategorized ? " · already categorized" : ""}`}
                        meta={`${r.amountCents < 0 ? "Inflow" : "Outflow"} ${formatCents(Math.abs(r.amountCents), r.isoCurrency)}`}
                      />
                    ))}
                  </RowIndex>
                ) : (
                  <p>
                    No matching history in this month. You can still save this rule for future
                    arrivals.
                  </p>
                )}
              </div>
            ) : null}
          </>
        )}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </Dialog>
  );
}
