//! A fake Plaid for tests. It answers the calls Finance makes, as plain request to reply
//! functions, so a test can use it as a transport without a network.
//!
//! It behaves like Plaid on the points that matter here. Every call must carry the client id and
//! secret in the JSON body. A public token works once. An access token works only for the item
//! that minted it. Errors carry Plaid's error codes. Every call it receives is recorded, so a
//! test can check what the host attached.

use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};

pub struct PlaidConfig {
    pub client_id: String,
    pub secret: String,
    /// Put into every minted access token, so a test can search for it.
    pub marker: String,
    /// Put into the invented merchant and account names.
    pub private_marker: String,
}

pub struct Seen {
    pub host: String,
    pub path: String,
    pub body: Value,
}

struct Item {
    id: String,
    n: usize,
    accounts: Vec<(String, String, f64)>,
}

#[derive(Default)]
struct Inner {
    counter: u32,
    link_tokens: HashMap<String, Vec<String>>,
    public_tokens: HashMap<String, (bool, usize)>,
    access: HashMap<String, Item>,
    seen: Vec<Seen>,
    /// Link tokens made in update mode, with the item they reconnect.
    update_links: HashMap<String, usize>,
    /// Items that refuse every call, with the error code they answer.
    failing: HashMap<usize, String>,
    /// Opt-in behaviour a test switches on.
    paginate: bool,
    mutate_once: bool,
    changes: Option<(Vec<Value>, Vec<String>)>,
}

pub struct PlaidStandIn {
    cfg: PlaidConfig,
    inner: Mutex<Inner>,
}

fn error(status: u16, kind: &str, code: &str) -> (u16, Value) {
    (
        status,
        json!({"error_type":kind,"error_code":code,"error_message":format!("fake plaid: {code}"),"request_id":"req-fake"}),
    )
}

impl PlaidStandIn {
    pub fn new(cfg: PlaidConfig) -> Self {
        Self {
            cfg,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// The person finishing the hosted bank page. Gives the link a public token.
    pub fn complete_link(&self, link_token: &str) -> String {
        let mut inner = self.inner.lock().unwrap();
        inner.counter += 1;
        let public = format!("public-sandbox-{}", inner.counter);
        let item = match inner.update_links.get(link_token) {
            Some(n) => *n,
            None => inner.public_tokens.len(),
        };
        inner.public_tokens.insert(public.clone(), (false, item));
        inner
            .link_tokens
            .get_mut(link_token)
            .expect("known link token")
            .push(public.clone());
        public
    }

    /// From now on every call for this item answers `code`, as Plaid does for a bank that needs
    /// the person to sign in again.
    pub fn fail_item(&self, item: usize, code: &str) {
        self.inner.lock().unwrap().failing.insert(item, code.into());
    }

    /// The first sync arrives as two pages instead of one.
    pub fn paginate(&self) {
        self.inner.lock().unwrap().paginate = true;
    }

    /// The next read of the second page fails once with the mid-read change error.
    pub fn mutate_once(&self) {
        self.inner.lock().unwrap().mutate_once = true;
    }

    /// Delivered once, on the sync that follows the second page: changed and removed transactions.
    pub fn queue_changes(&self, modified: Vec<Value>, removed: Vec<String>) {
        self.inner.lock().unwrap().changes = Some((modified, removed));
    }

    /// Link tokens the person has not finished yet.
    pub fn open_links(&self) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        let mut open: Vec<String> =
            inner.link_tokens.iter().filter(|(_, p)| p.is_empty()).map(|(l, _)| l.clone()).collect();
        open.sort();
        open
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.inner
            .lock()
            .unwrap()
            .seen
            .iter()
            .map(|s| Seen {
                host: s.host.clone(),
                path: s.path.clone(),
                body: s.body.clone(),
            })
            .collect()
    }

    pub fn minted_access_tokens(&self) -> Vec<String> {
        self.inner.lock().unwrap().access.keys().cloned().collect()
    }

    pub fn handle(&self, host: &str, path: &str, body: &Value) -> (u16, Value) {
        let mut inner = self.inner.lock().unwrap();
        inner.seen.push(Seen {
            host: host.into(),
            path: path.into(),
            body: body.clone(),
        });
        if host != "sandbox.plaid.com" && host != "production.plaid.com" {
            return error(400, "INVALID_REQUEST", "UNKNOWN_HOST");
        }
        if body["client_id"] != self.cfg.client_id.as_str()
            || body["secret"] != self.cfg.secret.as_str()
        {
            return error(400, "INVALID_INPUT", "INVALID_API_KEYS");
        }
        let marker = self.cfg.marker.clone();
        fn item_for<'a>(inner: &'a Inner, body: &Value) -> Option<&'a Item> {
            body["access_token"]
                .as_str()
                .and_then(|t| inner.access.get(t))
        }
        match path {
            "/link/token/create" => {
                inner.counter += 1;
                let link = format!("link-sandbox-{}", inner.counter);
                inner.link_tokens.insert(link.clone(), vec![]);
                // A request that carries a bank token is a reconnect of that bank.
                if let Some(n) = item_for(&inner, body).map(|i| i.n) {
                    inner.update_links.insert(link.clone(), n);
                }
                (
                    200,
                    json!({"link_token":link,"hosted_link_url":format!("https://secure.sandbox.plaid.com/hl/{}", inner.counter),"expiration":"2099-01-01T00:00:00Z","request_id":"req-fake"}),
                )
            }
            "/link/token/get" => {
                let Some(link) = body["link_token"]
                    .as_str()
                    .and_then(|l| inner.link_tokens.get(l))
                else {
                    return error(400, "INVALID_INPUT", "INVALID_LINK_TOKEN");
                };
                let results: Vec<Value> = link.iter().map(|p| json!({"public_token":p})).collect();
                let session = if results.is_empty() {
                    json!({"status":"IN_PROGRESS","results":{"item_add_results":[]}})
                } else {
                    json!({"status":"SUCCESS","results":{"item_add_results":results}})
                };
                (
                    200,
                    json!({"link_sessions":[session],"request_id":"req-fake"}),
                )
            }
            "/item/public_token/exchange" => {
                let Some(public) = body["public_token"].as_str() else {
                    return error(400, "INVALID_REQUEST", "MISSING_FIELDS");
                };
                let Some((used, n)) = inner.public_tokens.get(public).cloned() else {
                    return error(400, "INVALID_INPUT", "INVALID_PUBLIC_TOKEN");
                };
                if used {
                    return error(400, "INVALID_INPUT", "INVALID_PUBLIC_TOKEN");
                }
                inner.public_tokens.insert(public.into(), (true, n));
                // Signing in again clears the bank's refusal.
                inner.failing.remove(&n);
                inner.counter += 1;
                let access = format!("access-sandbox-{marker}-{}", inner.counter);
                let private = self.cfg.private_marker.clone();
                let id = format!("item-{n}");
                inner.access.insert(
                    access.clone(),
                    Item {
                        id: id.clone(),
                        n,
                        accounts: vec![
                            (
                                format!("acc-{n}-1"),
                                format!("Checking {private}"),
                                1234.56 + n as f64,
                            ),
                            (format!("acc-{n}-2"), format!("Savings {private}"), 7890.12),
                        ],
                    },
                );
                (
                    200,
                    json!({"access_token":access,"item_id":id,"request_id":"req-fake"}),
                )
            }
            "/institutions/get_by_id" => (
                200,
                json!({"institution":{"institution_id":body["institution_id"],"name":"Invented Bank"},"request_id":"req-fake"}),
            ),
            "/accounts/balance/get" | "/accounts/get" => {
                let Some(item) = item_for(&inner, body) else {
                    return error(400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN");
                };
                if let Some(code) = inner.failing.get(&item.n) {
                    return error(400, "ITEM_ERROR", code);
                }
                let accounts: Vec<Value> = item
                    .accounts
                    .iter()
                    .map(|(id, name, balance)| json!({"account_id":id,"name":name,"type":"depository","subtype":"checking","mask":"0000","balances":{"current":balance,"iso_currency_code":"USD"}}))
                    .collect();
                (
                    200,
                    json!({"accounts":accounts,"item":{"item_id":item.id,"institution_id":"ins_invented"},"request_id":"req-fake"}),
                )
            }
            "/transactions/sync" => {
                let Some(item) = item_for(&inner, body) else {
                    return error(400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN");
                };
                if let Some(code) = inner.failing.get(&item.n) {
                    return error(400, "ITEM_ERROR", code);
                }
                let (item_id, account, n) = (item.id.clone(), item.accounts[0].0.clone(), item.n);
                let tx = |k: u32, amount: f64| json!({"transaction_id":format!("tx-{item_id}-{k}"),"account_id":account,"date":"2026-11-01","amount":amount,"iso_currency_code":"USD","name":format!("Merchant {} {k}", self.cfg.private_marker),"merchant_name":null,"personal_finance_category":{"primary":"FOOD_AND_DRINK"},"pending":false,"pending_transaction_id":null});
                let cursor = body["cursor"].as_str().map(str::to_owned);
                let page = |added: Vec<Value>, modified: Vec<Value>, removed: Vec<String>, next: &str, more: bool| {
                    let removed: Vec<Value> = removed.into_iter().map(|r| json!({"transaction_id":r})).collect();
                    (200, json!({"added":added,"modified":modified,"removed":removed,"next_cursor":next,"has_more":more,"request_id":"req-fake"}))
                };
                let _ = n;
                match cursor.as_deref() {
                    None if inner.paginate => page(vec![tx(1, 42.5)], vec![], vec![], "c1", true),
                    None => page(vec![tx(1, 42.5)], vec![], vec![], "cursor-1", false),
                    Some("c1") if inner.mutate_once => {
                        inner.mutate_once = false;
                        error(400, "TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")
                    }
                    Some("c1") => page(vec![tx(2, 7.25)], vec![], vec![], "c2", false),
                    Some("c2") if inner.changes.is_some() => {
                        let (modified, removed) = inner.changes.take().unwrap();
                        page(vec![], modified, removed, "c3", false)
                    }
                    Some(other) => page(vec![], vec![], vec![], other, false),
                }
            }
            _ => error(404, "INVALID_REQUEST", "UNKNOWN_ROUTE"),
        }
    }
}

/// The fake as a small web server, for a live run. A request is `POST /<host>/<path>` with the
/// JSON body Plaid expects, so the original host survives the trip over plain http.
pub fn router(plaid: std::sync::Arc<PlaidStandIn>) -> axum::Router {
    use axum::{extract::Path, routing::post, Json};
    axum::Router::new().route(
        "/{host}/{*path}",
        post(move |Path((host, path)): Path<(String, String)>, Json(body): Json<Value>| {
            let plaid = plaid.clone();
            async move {
                let (status, reply) = plaid.handle(&host, &format!("/{path}"), &body);
                (axum::http::StatusCode::from_u16(status).unwrap(), Json(reply))
            }
        }),
    )
}
