//! Linking a bank. `start` makes a hosted bank page address. `poll` finishes the link once the
//! person has used the page, saves the bank and pulls its first data. The bank token goes
//! straight from Plaid into the host credential store, so this code never sees it.
use crate::bank::{self, ITEMS, LINKS, SESSIONS};
use crate::input::{refuse, Refusal};
use crate::ledger::{first, log_as, values};
use crate::plaid::{self, PlaidError};
use crate::sync;
use chrono::DateTime;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

/// A link left alone this long is dropped.
const ABANDON_AFTER_SECONDS: i64 = 30 * 60;
const POLL_EVERY_SECONDS: i64 = 15;

pub type Outcome = std::result::Result<Value, Refusal>;

fn unavailable() -> Refusal {
    refuse("bank_unavailable", "The bank service could not start the link. Try again in a moment")
}

/// `finance.connect.start`. A bank that needs a new sign-in is fixed in place, with no new bank.
pub fn start<H: Host + ?Sized>(host: &H) -> Result<Outcome> {
    if !plaid::keys_saved(host)? {
        return Ok(Err(unavailable()));
    }
    let client_user = crate::ledger::text(host, "call", "read", "actorUserId")?;
    let items = bank::items(host)?;
    let reauth = items.iter().find(|i| i["status"] == "reauth-required");
    let mut update = None;
    if let Some(item) = reauth {
        let id = item["item_id"].as_str().unwrap_or_default();
        match bank::link(host, id)?.and_then(|l| l["slot"].as_str().map(str::to_owned)) {
            Some(slot) => update = Some((id.to_owned(), slot)),
            None => return Ok(Err(refuse("token_read_failed", "The saved bank sign-in could not be read. Try again"))),
        }
    }
    let reply = match plaid::link_token_create(host, &client_user, update.as_ref().map(|u| u.1.as_str()))? {
        Ok(reply) => reply,
        Err(_) => return Ok(Err(unavailable())),
    };
    let (Some(token), Some(url)) = (reply["link_token"].as_str(), reply["hosted_link_url"].as_str()) else {
        return Ok(Err(unavailable()));
    };
    Client(host).query(
        SESSIONS,
        &Query::insert(values(vec![
            ("link_token", json!(token)),
            ("started_at", json!(bank::now(host)?)),
            ("update_item_id", json!(update.map(|u| u.0))),
        ])),
    )?;
    bank::enqueue_poll(host, &format!("finance-poll:{token}"), POLL_EVERY_SECONDS);
    Ok(Ok(json!({
        "status":"pending",
        "hostedLinkUrl":url,
        "nextStep":"Open the link to connect the bank, then run finance.connect.poll to finish the connection."
    })))
}

struct Tally {
    completed: u32,
    pending: u32,
    abandoned: u32,
}

/// `finance.connect.poll` and the delayed poll job. `chain` asks for another poll while a
/// link is still waiting, which only the job does.
pub fn poll<H: Host + ?Sized>(host: &H, chain: bool) -> Result<Value> {
    let now = bank::now(host)?;
    let mut tally = Tally { completed: 0, pending: 0, abandoned: 0 };
    let sessions = Client(host).query(SESSIONS, &Query::select(Filter::All))?;
    for session in &sessions {
        let Some(token) = session["link_token"].as_str() else { continue };
        if age_seconds(&now, session["started_at"].as_str().unwrap_or_default()) > ABANDON_AFTER_SECONDS {
            drop_session(host, token)?;
            tally.abandoned += 1;
            continue;
        }
        let (status, publics) = match plaid::link_token_get(host, token)? {
            Ok(state) => state,
            Err(_) => {
                tally.pending += 1;
                continue;
            }
        };
        if status == "expired" {
            drop_session(host, token)?;
            tally.abandoned += 1;
            continue;
        }
        if status == "pending" || publics.is_empty() {
            tally.pending += 1;
            continue;
        }
        let mut finished = true;
        for public in &publics {
            finished &= complete(host, public, session["update_item_id"].as_str())?.is_ok();
        }
        if finished {
            drop_session(host, token)?;
            tally.completed += 1;
        } else {
            tally.pending += 1;
        }
    }
    if tally.completed > 0 {
        bank::keep_scheduled(host);
        // The first sync is best effort. The schedule and the run-now tool try again.
        let _ = sync::run(host);
    }
    if chain && tally.pending > 0 {
        bank::enqueue_poll(host, &format!("finance-poll:{now}"), POLL_EVERY_SECONDS);
    }
    let next = if tally.completed > 0 {
        "Connected. Your balances and transactions are on their way."
    } else if tally.pending > 0 {
        "Still pending. Finish the bank login in the opened link, then poll again."
    } else {
        "No pending connections. Start one with finance.connect.start."
    };
    Ok(json!({"status":"ok","completed":tally.completed,"pending":tally.pending,"abandoned":tally.abandoned,"nextStep":next}))
}

fn age_seconds(now: &str, then: &str) -> i64 {
    match (DateTime::parse_from_rfc3339(now), DateTime::parse_from_rfc3339(then)) {
        (Ok(now), Ok(then)) => (now - then).num_seconds(),
        _ => 0,
    }
}

fn drop_session<H: Host + ?Sized>(host: &H, token: &str) -> Result<()> {
    Client(host).query(SESSIONS, &Query::delete(Filter::eq("link_token", token)))?;
    Ok(())
}

/// Saves one finished bank link. A failure leaves the link waiting, so the next poll retries.
fn complete<H: Host + ?Sized>(host: &H, public: &str, update_item: Option<&str>) -> Result<std::result::Result<(), PlaidError>> {
    let slot = bank::slot_for(public);
    let item_id = match plaid::exchange(host, &slot, public)? {
        Ok(id) => id,
        Err(code) => {
            // A retry after the token was already stored finds the bank through its slot.
            if code == "INVALID_PUBLIC_TOKEN" && plaid::configured(host, &slot)? {
                match plaid::accounts(host, &slot, "/accounts/get")? {
                    Ok(listing) if listing.item_id.is_some() => listing.item_id.unwrap_or_default(),
                    _ => return Ok(Err(failed(code))),
                }
            } else {
                return Ok(Err(failed(code)));
            }
        }
    };
    let listing = match plaid::accounts(host, &slot, "/accounts/get")? {
        Ok(listing) => listing,
        Err(e) => return Ok(Err(e)),
    };
    let at = bank::now(host)?;
    let client = Client(host);
    // A reconnect replaces the bank's token. The old one is dropped from the store.
    match bank::link(host, &item_id)? {
        Some(old) => {
            let previous = old["slot"].as_str().unwrap_or_default().to_owned();
            client.query(
                LINKS,
                &Query::update(
                    Filter::eq("item_id", item_id.clone()),
                    values(vec![("slot", json!(slot))]),
                ),
            )?;
            if previous != slot && !previous.is_empty() {
                plaid::forget(host, &previous)?;
            }
        }
        None => {
            client.query(
                LINKS,
                &Query::insert(values(vec![("item_id", json!(item_id)), ("slot", json!(slot))])),
            )?;
        }
    }
    let state = vec![
        ("status", json!("connected")),
        ("last_error", Value::Null),
        ("last_error_detail", Value::Null),
        ("institution_id", json!(listing.institution)),
    ];
    if first(host, ITEMS, Filter::eq("item_id", item_id.clone()))?.is_some() {
        bank::update_item(host, &item_id, state)?;
    } else {
        let mut row = values(state);
        row.insert("item_id".into(), json!(item_id));
        row.insert("connected_at".into(), json!(at));
        client.query(ITEMS, &Query::insert(row))?;
    }
    bank::store_accounts(host, &item_id, &listing.accounts, &at)?;
    log_as(host, "user", if update_item.is_some() { "bank.reconnect" } else { "bank.connect" }, json!({"itemId":item_id}))?;
    Ok(Ok(()))
}

fn failed(code: String) -> PlaidError {
    PlaidError { code, status: 0, detail: Value::Null }
}
