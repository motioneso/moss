//! Rows for connected banks: items, the token slot and sync cursor for each, and link sessions.
//! A bank token itself lives only in the host credential store, under the slot named here.
use crate::ledger::{first, text, values, ACCOUNTS};
use crate::plaid::{Account, PlaidError};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const ITEMS: &str = "app.finance_items";
pub const LINKS: &str = "app.finance_bank_links";
pub const SESSIONS: &str = "app.finance_link_sessions";
pub const SNAPSHOTS: &str = "app.finance_balance_snapshots";
pub const SWEEP_QUEUE: &str = "finance.sync-run";
pub const POLL_QUEUE: &str = "finance.connect-poll";
/// Minute 41 of every sixth hour.
const SWEEP_CRON: &str = "41 */6 * * *";

pub fn now<H: Host + ?Sized>(host: &H) -> Result<String> {
    text(host, "call", "read", "now")
}

pub fn hex(text: &str, length: usize) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>()[..length].to_owned()
}

/// The credential slot for a bank. It comes from the one-use public token, so a retried
/// connection reaches the same slot and a different bank never shares one.
pub fn slot_for(public_token: &str) -> String {
    format!("s{}", hex(public_token, 40))
}

/// A stable job key in uuid form, so a repeated enqueue of the same step is dropped.
pub fn job_key(seed: &str) -> String {
    let h = hex(seed, 32);
    format!("{}-{}-4{}-8{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

pub fn items<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>> {
    Client(host).query(ITEMS, &Query::select(Filter::All))
}

pub fn link<H: Host + ?Sized>(host: &H, item: &str) -> Result<Option<Value>> {
    first(host, LINKS, Filter::eq("item_id", item))
}

pub fn update_item<H: Host + ?Sized>(host: &H, item: &str, pairs: Vec<(&str, Value)>) -> Result<()> {
    Client(host).query(ITEMS, &Query::update(Filter::eq("item_id", item), values(pairs)))?;
    Ok(())
}

/// A refusal from Plaid becomes the item's stored state. Login-required asks for a reconnect.
pub fn fail_item<H: Host + ?Sized>(host: &H, item: &str, error: &PlaidError) -> Result<&'static str> {
    let status = if error.code == "ITEM_LOGIN_REQUIRED" { "reauth-required" } else { "error" };
    update_item(
        host,
        item,
        vec![("status", json!(status)), ("last_error", json!(error.code)), ("last_error_detail", json!(error.detail.to_string()))],
    )?;
    Ok(status)
}

/// Inserts the bank's accounts, or refreshes the ones already there. A manual account is never
/// touched, and sharing is never changed.
pub fn store_accounts<H: Host + ?Sized>(host: &H, item: &str, accounts: &[Account], at: &str) -> Result<()> {
    let client = Client(host);
    for a in accounts {
        let shared = vec![
            ("item_id", json!(item)),
            ("name", json!(a.name)),
            ("official_name", json!(a.official_name)),
            ("type", json!(a.kind)),
            ("subtype", json!(a.subtype)),
            ("mask", json!(a.mask)),
            ("balance_cents", json!(a.balance_cents)),
            ("iso_currency", json!(a.currency)),
            ("updated_at", json!(at)),
        ];
        match first(host, ACCOUNTS, Filter::eq("account_id", a.id.clone()))? {
            Some(row) if row["source"] == "manual" => {}
            Some(_) => {
                client.query(ACCOUNTS, &Query::update(Filter::eq("account_id", a.id.clone()), values(shared)))?;
            }
            None => {
                let mut row = values(shared);
                row.insert("account_id".into(), json!(a.id));
                client.query(ACCOUNTS, &Query::insert(row))?;
            }
        }
    }
    Ok(())
}

/// The first balance written for a day stays.
pub fn snapshot<H: Host + ?Sized>(host: &H, accounts: &[Account], day: &str) -> Result<()> {
    for a in accounts {
        let mut insert = Query::insert(values(vec![
            ("account_id", json!(a.id)),
            ("day", json!(day)),
            ("balance_cents", json!(a.balance_cents)),
        ]));
        insert.conflict = Conflict::Ignore;
        Client(host).query(SNAPSHOTS, &insert)?;
    }
    Ok(())
}

/// Makes sure this person's six-hour sweep is scheduled. A failure never fails the request.
pub fn keep_scheduled<H: Host + ?Sized>(host: &H) {
    let _ = host.call(
        "jobs",
        "schedule",
        SWEEP_QUEUE,
        json!({"cron": SWEEP_CRON, "timezone": "UTC", "key": "finance-sync-sweep", "keepExisting": true, "params": {}}),
    );
}

/// Asks for the next poll after the commit, `seconds` from now.
pub fn enqueue_poll<H: Host + ?Sized>(host: &H, seed: &str, seconds: i64) {
    let Ok(now) = now(host) else { return };
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(&now) else { return };
    let at = (at + chrono::Duration::seconds(seconds)).to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let _ = host.call(
        "jobs",
        "enqueue-after-commit",
        POLL_QUEUE,
        json!({"params": {}, "idempotencyKey": job_key(seed), "availableAt": at}),
    );
}
