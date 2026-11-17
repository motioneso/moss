//! Finance package, parts 20 to 22: the account list, manual accounts and entries, bank connect
//! and sync, and transactions, rules, categories and CSV import, all private to each owner.
//! Everything crosses the guest-safe SDK Host interface. Bank keys and tokens stay in the host
//! broker. No amount or account name is written to logs, jobs or activity rows.
/// Leaves with the refusal when a reader fails.
macro_rules! ask {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(refusal) => return Ok(Err(refusal)),
        }
    };
}

pub mod accounts;
pub mod budget;
pub mod budget_write;
pub mod bank;
pub mod categories;
pub mod connect;
pub mod csv_import;
pub mod draft;
pub mod envelope;
pub mod export;
pub mod input;
pub mod ledger;
pub mod reports;
pub mod rules;
pub mod plaid;
pub mod sort_run;
pub mod splits;
pub mod sorting;
pub mod shared;
pub mod sync;
pub mod text;
pub mod tools;
pub mod transactions;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::json;

/// Routes use the module-relative path template. A host failure leaves as a fixed message,
/// because host errors can carry request text.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/finance/accounts") => accounts::list(host).map(|v| Response::new(200, v)),
        ("GET", "/finance/manual/context") => accounts::context(host).map(|v| Response::new(200, v)),
        ("POST", "/finance/manual/accounts") => {
            tools::route_write(ledger::create_account(host, &request.body))
        }
        ("POST", "/finance/manual/entries") => {
            tools::route_write(ledger::create_entry(host, &request.body))
        }
        ("POST", "/finance/connect/start") => tools::route_write(connect::start(host)),
        ("POST", "/finance/connect/poll") => connect::poll(host, false).map(|v| Response::new(200, v)),
        ("POST", "/finance/sync/run-now") => sync::run(host).map(|v| Response::new(200, v)),
        _ => match (request.method.as_str(), tool_for(request.method.as_str(), request.path.as_str())) {
            (_, Some((tool, true))) => chat(host, tool, &request),
            (_, Some((tool, false))) => direct(host, tool, &request),
            _ => return Response::new(404, json!({"message":"Route not found"})),
        },
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"error":"Internal server error"})))
}

/// Route to tool name. The flag says the route is the assistant's write path.
fn tool_for(method: &str, path: &str) -> Option<(&'static str, bool)> {
    Some(match (method, path) {
        ("GET", "/finance/transactions") => ("finance.transactions.query", false),
        ("POST", "/finance/transactions/category") => ("finance.transactions.category-set", false),
        ("POST", "/finance/transactions/review") => ("finance.transactions.review-apply", false),
        ("POST", "/finance/transactions/bulk-categorize") => ("finance.transactions.bulk-categorize", false),
        ("POST", "/finance/transactions/bulk-confirm") => ("finance.transactions.bulk-confirm", false),
        ("GET", "/finance/transactions/notes") => ("finance.transactions.notes.read", false),
        ("POST", "/finance/transactions/notes") => ("finance.transactions.notes.save", false),
        ("POST", "/finance/transactions/splits") => ("finance.transactions.splits", false),
        ("GET", "/finance/rules") => ("finance.rules.list", false),
        ("GET", "/finance/rules/preview") => ("finance.rules.preview", false),
        ("POST", "/finance/rules") => ("finance.rules.update", false),
        ("POST", "/finance/categories") => ("finance.categories.upsert", false),
        ("POST", "/finance/import/parse") => ("finance.import.parse", false),
        ("POST", "/finance/import/preview") => ("finance.import.preview", false),
        ("POST", "/finance/import/apply") => ("finance.import.apply", false),
        ("POST", "/finance/sorting/run") => ("finance.sorting.run", false),
        ("POST", "/finance/chat/connect/start") => ("finance.connect.start", true),
        ("POST", "/finance/chat/connect/poll") => ("finance.connect.poll", true),
        ("POST", "/finance/chat/sync/run-now") => ("finance.sync.run-now", true),
        ("POST", "/finance/chat/manual/account-create") => ("finance.manual.account-create", true),
        ("POST", "/finance/chat/manual/entry-create") => ("finance.manual.entry-create", true),
        ("POST", "/finance/chat/transactions/categorize") => ("finance.transactions.categorize", true),
        ("POST", "/finance/chat/transactions/categorize-new") => ("finance.transactions.categorize-new", true),
        ("POST", "/finance/chat/transactions/review") => ("finance.transactions.review-apply", true),
        ("POST", "/finance/chat/transactions/bulk-categorize") => ("finance.transactions.bulk-categorize", true),
        ("POST", "/finance/chat/transactions/bulk-confirm") => ("finance.transactions.bulk-confirm", true),
        ("POST", "/finance/chat/transactions/notes") => ("finance.transactions.notes.save", true),
        ("POST", "/finance/chat/transactions/splits") => ("finance.transactions.splits", true),
        ("POST", "/finance/chat/rules/set") => ("finance.rule.set", true),
        ("POST", "/finance/chat/import/apply") => ("finance.import.apply", true),
        ("GET", "/finance/budget/status") => ("finance.budget.status", false),
        ("GET", "/finance/budget/draft") => ("finance.budget.draft.get", false),
        ("POST", "/finance/budget/configure") => ("finance.budget.configure", false),
        ("POST", "/finance/budget/assign") => ("finance.budget.assign", false),
        ("POST", "/finance/budget/move") => ("finance.budget.move", false),
        ("POST", "/finance/budget/apply") => ("finance.budget.apply", false),
        ("POST", "/finance/budget/draft/build") => ("finance.budget.draft.build", false),
        ("POST", "/finance/budget/draft/update") => ("finance.budget.draft.update", false),
        ("POST", "/finance/budget/draft/start") => ("finance.budget.draft.start", false),
        ("POST", "/finance/chat/budget/configure") => ("finance.budget.configure", true),
        ("POST", "/finance/chat/budget/assign") => ("finance.budget.assign", true),
        ("POST", "/finance/chat/budget/move") => ("finance.budget.move", true),
        ("POST", "/finance/chat/budget/apply") => ("finance.budget.apply", true),
        ("POST", "/finance/chat/budget/draft/build") => ("finance.budget.draft.build", true),
        ("POST", "/finance/chat/budget/draft/update") => ("finance.budget.draft.update", true),
        ("POST", "/finance/chat/budget/draft/start") => ("finance.budget.draft.start", true),
        _ => return None,
    })
}

/// A screen route runs the tool's code directly and answers with its status.
fn direct<H: Host + ?Sized>(host: &H, tool: &str, request: &RouteRequest) -> moss_module_sdk::Result<Response> {
    let parameters = if request.method == "GET" { json!(request.query) } else { request.body.clone() };
    let reply = tools::execute(host, tools::Request { tool: tool.into(), parameters })?;
    let status = match reply["status"] == "error" {
        true => tools::status_of(&reply),
        false => 200,
    };
    Ok(Response::new(status, reply))
}

/// The assistant's write path. The host checks the account's one-use approval before it runs.
fn chat<H: Host + ?Sized>(host: &H, tool: &str, request: &RouteRequest) -> moss_module_sdk::Result<Response> {
    let reply = host.call("tools", "run", tool, json!({"parameters":request.body}))?;
    let status = if reply["status"] == "error" { tools::status_of(&reply) } else { 200 };
    Ok(Response::new(status, reply))
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(
    host: &H,
    kind: &str,
    payload: &str,
) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route(host, request))?)
        }
        "job" => {
            let job: serde_json::Value = serde_json::from_str(payload)?;
            let done = match job["queue"].as_str() {
                Some(bank::SWEEP_QUEUE) => sync::run(host)?,
                Some(bank::POLL_QUEUE) => connect::poll(host, true)?,
                _ => return Err(moss_module_sdk::Error::new("Unsupported Finance job")),
            };
            Ok(done.to_string())
        }
        "tool" => {
            let result = tools::execute(host, serde_json::from_str(payload)?)
                .map_err(|_| moss_module_sdk::Error::new("Finance tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        _ => Err(moss_module_sdk::Error::new("Unsupported Finance invocation")),
    }
}
