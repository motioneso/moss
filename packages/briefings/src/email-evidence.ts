import { localDay, type BriefingEmailEvidenceV1, type LocaleSettingsDto } from "@moss/shared";

// The source cache returns 200 recent messages plus 25 older actionable messages.
const EVIDENCE_CAP = 225;
const BILLING = /\b(bills?|invoices?|payments?|statements?|past[ -]due|auto-?pay)\b/i;
const SETTLED = /\b(paid in full|fully paid|payment (?:received|confirmed|successful))\b/i;
const NOT_SETTLED = /\b(not|unpaid|failed|pending|partial|partially)\b/i;

function text(item: Record<string, unknown>): string {
  return [item.subject, item.summary, item.snippet]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function receiptText(item: Record<string, unknown>): string {
  return [item.subject, item.snippet]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function invoiceId(item: Record<string, unknown>): string | null {
  // A sender or thread may contain several invoices; only an explicit number can match.
  const ids = new Set(
    [
      ...receiptText(item).matchAll(
        /\b(?:invoice|bill|statement)\s*(?:number|no\.?|#)\s*:?\s*([a-z0-9-]+)/gi
      )
    ].map((match) => match[1]!.toLowerCase())
  );
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Reconcile against all fetched mail before receipts are removed from action/prose selection. */
export function assessBriefingEmailEvidence(
  items: readonly Record<string, unknown>[],
  now: Date,
  locale: LocaleSettingsDto
): { evidence: BriefingEmailEvidenceV1; eligibleItems: Record<string, unknown>[] } {
  const today = localDay(now, locale.timezone);
  const bounded = items.slice(0, EVIDENCE_CAP);
  const eligibleItems: Record<string, unknown>[] = [];
  const assessments: BriefingEmailEvidenceV1["items"][number][] = [];
  for (const item of bounded) {
    const messageId = typeof item.id === "string" && item.id.trim() ? item.id : null;
    const account = typeof item.connectorAccountId === "string" ? item.connectorAccountId : "";
    const stamp = typeof item.receivedAt === "string" ? Date.parse(item.receivedAt) : NaN;
    const validDate = Number.isFinite(stamp) && stamp <= now.getTime();
    const receivedDay = validDate ? localDay(new Date(stamp), locale.timezone) : null;
    const ageDays =
      receivedDay === null
        ? null
        : Math.round(
            (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${receivedDay}T00:00:00Z`)) / 86_400_000
          );
    const billing = BILLING.test(text(item));
    const invoice = billing ? invoiceId(item) : null;
    const receipts =
      invoice && account
        ? bounded.filter((other) => {
            const at = typeof other.receivedAt === "string" ? Date.parse(other.receivedAt) : NaN;
            return (
              other.actionability === "receipt_or_notice" &&
              other.connectorAccountId === account &&
              typeof item.sender === "string" &&
              typeof other.sender === "string" &&
              item.sender.trim().toLowerCase() === other.sender.trim().toLowerCase() &&
              invoiceId(other) === invoice &&
              validDate &&
              at > stamp &&
              at <= now.getTime() &&
              typeof other.id === "string" &&
              other.id.trim().length > 0 &&
              SETTLED.test(receiptText(other)) &&
              !NOT_SETTLED.test(receiptText(other))
            );
          })
        : [];
    const informational =
      item.actionability === "receipt_or_notice" || item.actionability === "noise";
    const status =
      receipts.length > 0
        ? "settled"
        : informational
          ? "informational"
          : !messageId || !account || !validDate || billing || ageDays !== 0
            ? "current_status_unknown"
            : "reported_today";
    const reason =
      status === "settled"
        ? "later_matching_payment_confirmation"
        : informational
          ? "receipt_or_noise"
          : !messageId || !account || !validDate
            ? "missing_identity_or_date"
            : billing
              ? "no_current_unpaid_evidence"
              : ageDays !== 0
                ? "historical_message"
                : "received_on_observation_day";
    if (status === "reported_today") eligibleItems.push(item);
    else if (
      status === "current_status_unknown" &&
      validDate &&
      messageId &&
      account &&
      ageDays !== null &&
      ((billing && ageDays === 0) ||
        (!billing && ageDays > 0 && item.actionability === "needs_reply"))
    ) {
      eligibleItems.push({
        ...item,
        briefingCurrentStatusUnknown: true,
        ...(billing ? { briefingPaymentStatusUnknown: true } : {})
      });
    }
    if (messageId)
      assessments.push({
        messageId,
        connectorAccountId: account,
        threadId: typeof item.threadId === "string" ? item.threadId : null,
        receivedAt: validDate ? new Date(stamp).toISOString() : null,
        ageDays,
        actionability: typeof item.actionability === "string" ? item.actionability : null,
        awaitingJudgement: item.awaitingJudgement === true,
        status,
        reason,
        contraryMessageIds: [...new Set(receipts.map((receipt) => String(receipt.id)))],
        rank: null,
        rankingReasons: []
      });
  }
  return {
    eligibleItems,
    evidence: {
      version: 1,
      capturedAt: now.toISOString(),
      localDate: today,
      truncated: items.length > EVIDENCE_CAP,
      items: assessments
    }
  };
}
