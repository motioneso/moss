//! What each gathered email proves about today. Keywords and message age cannot show that a bill
//! is still unpaid, so a message is reported as current only when its own date and identity
//! support it. A later matching payment confirmation settles it. The result is stored with the
//! run as ids, dates, statuses and reasons, never message text.
use crate::text::js_trim;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// The mail cache returns 200 recent messages plus 25 older actionable ones.
pub const EVIDENCE_CAP: usize = 225;

struct Rules {
    billing: Regex,
    settled: Regex,
    not_settled: Regex,
    requests: Regex,
    confirmation: Regex,
    invoice: Regex,
    no_action: Regex,
    no_reply: Regex,
}

fn rules() -> Rules {
    let re = |p: &str| Regex::new(p).expect("fixed pattern");
    Rules {
        billing: re(r"(?i)\b(bills?|invoices?|payments?|statements?|past[ -]due|auto-?pay)\b"),
        settled: re(r"(?i)\b(paid in full|fully paid|payment (?:received|confirmed|successful))\b"),
        not_settled: re(r"(?i)\b(not|unpaid|failed|pending|partial|partially)\b"),
        requests: re(
            r"\b(?:collect|schedule|due|need|needed|required|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)|action (?:is )?(?:needed|required)|(?:failed|declined|unpaid|pending|outstanding)|amount due|balance due|please (?:reply|respond|confirm|review|pay|update|complete)|(?:could|can|would|will|have|are) you|you (?:must|need to)|(?:reply|respond) (?:to|with)|(?:confirm|review|pay|complete|update) your|payment due|due by|(?:amount|balance|\$[0-9])[\w $.,]*due)\b",
        ),
        confirmation: re(
            r"\b(?:order (?:is |has been )?(?:confirmed|confirmation|received)|(?:package|parcel|order|shipment) (?:has |was |is )?(?:been )?(?:shipped|delivered|sent|dispatched)|(?:shipping|delivery) confirmation|(?:booking|reservation) (?:is |has been )?(?:confirmed|confirmation)|payment (?:was |is |has been )?(?:received|confirmed|successful)|^receipt (?:for|of)|(?:purchase|payment|order) receipt|subscription (?:has been |was |is )?renewed)\b",
        ),
        invoice: re(r"(?i)\b(?:invoice|bill|statement)\s*(?:number|no\.?|#)\s*:?\s*([a-z0-9-]+)"),
        no_action: re(r"\bno (?:further )?action (?:is )?(?:needed|required)\b"),
        no_reply: re(r"\b(?:do not|don't) reply\b"),
    }
}

fn joined(item: &Value, keys: &[&str]) -> String {
    keys.iter().filter_map(|k| item[*k].as_str()).collect::<Vec<_>>().join(" ")
}

fn is_action(item: &Value) -> bool {
    matches!(item["actionability"].as_str(), Some("needs_reply" | "needs_action" | "time_sensitive_info"))
}

fn confirmed(r: &Rules, item: &Value) -> bool {
    if is_action(item) {
        return false;
    }
    let source = joined(item, &["subject", "snippet"]).to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    let requests = r.no_reply.replace_all(&r.no_action.replace_all(&source, ""), "").into_owned();
    if r.requests.is_match(&requests) {
        return false;
    }
    r.confirmation.is_match(&source)
}

/// Mail that only confirms something already done. A request for action always wins.
pub fn is_no_action_confirmation(item: &Value) -> bool {
    confirmed(&rules(), item)
}

fn invoice_id(r: &Rules, item: &Value) -> Option<String> {
    // A sender or thread may hold several invoices, so only one explicit number can match.
    let text = joined(item, &["subject", "snippet"]);
    let ids: BTreeSet<String> = r.invoice.captures_iter(&text).map(|c| c[1].to_lowercase()).collect();
    (ids.len() == 1).then(|| ids.into_iter().next()).flatten()
}

fn stamp(item: &Value) -> Option<DateTime<Utc>> {
    item["receivedAt"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Utc))
}

fn millis(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub struct Assessment {
    pub evidence: Value,
    /// Mail still worth the writer's attention today.
    pub eligible: Vec<Value>,
}

pub fn assess(items: &[Value], now: DateTime<Utc>, zone: Tz) -> Assessment {
    let r = rules();
    let today = now.with_timezone(&zone).date_naive();
    let bounded = &items[..items.len().min(EVIDENCE_CAP)];
    let mut eligible: Vec<Value> = vec![];
    let mut rows: Vec<Value> = vec![];
    for item in bounded {
        let id = item["id"].as_str().filter(|s| !js_trim(s).is_empty());
        let account = item["connectorAccountId"].as_str().unwrap_or("");
        let at = stamp(item).filter(|t| *t <= now);
        let age = at.map(|t| (today - t.with_timezone(&zone).date_naive()).num_days());
        let billing = r.billing.is_match(&joined(item, &["subject", "summary", "snippet"]));
        let payment_unknown = billing && item["actionability"] != "needs_reply";
        let invoice = if billing { invoice_id(&r, item) } else { None };
        let receipts: Vec<&Value> = match (&invoice, at) {
            (Some(inv), Some(sent)) if !account.is_empty() => bounded
                .iter()
                .filter(|o| {
                    let (Some(later), Some(a), Some(b)) = (stamp(o), item["sender"].as_str(), o["sender"].as_str()) else {
                        return false;
                    };
                    let receipt = joined(o, &["subject", "snippet"]);
                    o["actionability"] == "receipt_or_notice"
                        && o["connectorAccountId"] == account
                        && js_trim(a).to_lowercase() == js_trim(b).to_lowercase()
                        && invoice_id(&r, o).as_deref() == Some(inv.as_str())
                        && later > sent
                        && later <= now
                        && o["id"].as_str().is_some_and(|s| !js_trim(s).is_empty())
                        && r.settled.is_match(&receipt)
                        && !r.not_settled.is_match(&receipt)
                })
                .collect(),
            _ => vec![],
        };
        let confirmation = confirmed(&r, item);
        let informational = confirmation || matches!(item["actionability"].as_str(), Some("receipt_or_notice" | "noise"));
        let valid = id.is_some() && !account.is_empty() && at.is_some();
        let (status, reason) = if !receipts.is_empty() {
            ("settled", "later_matching_payment_confirmation")
        } else if informational {
            ("informational", if confirmation { "no_action_confirmation" } else { "receipt_or_noise" })
        } else if !valid {
            ("current_status_unknown", "missing_identity_or_date")
        } else if payment_unknown {
            ("current_status_unknown", "no_current_unpaid_evidence")
        } else if age != Some(0) {
            ("current_status_unknown", "historical_message")
        } else {
            ("reported_today", "received_on_observation_day")
        };
        if status == "reported_today" {
            eligible.push(item.clone());
        } else if status == "current_status_unknown"
            && valid
            && age.is_some_and(|a| (billing && a == 0) || (!billing && a > 0 && item["actionability"] == "needs_reply"))
        {
            let mut flagged = item.clone();
            flagged["briefingCurrentStatusUnknown"] = json!(true);
            if billing {
                flagged["briefingPaymentStatusUnknown"] = json!(true);
            }
            eligible.push(flagged);
        }
        if let Some(id) = id {
            let contrary: BTreeSet<&str> = receipts.iter().filter_map(|o| o["id"].as_str()).collect();
            rows.push(json!({
                "messageId": id, "connectorAccountId": account,
                "threadId": item["threadId"].as_str(),
                "receivedAt": at.map(millis), "ageDays": age,
                "actionability": item["actionability"].as_str(),
                "awaitingJudgement": item["awaitingJudgement"] == true,
                "status": status, "reason": reason,
                "contraryMessageIds": contrary, "rank": null, "rankingReasons": [],
            }));
        }
    }
    let evidence = json!({
        "version": 1, "capturedAt": millis(now), "localDate": today.to_string(),
        "truncated": items.len() > EVIDENCE_CAP, "items": rows,
    });
    Assessment { evidence, eligible }
}
