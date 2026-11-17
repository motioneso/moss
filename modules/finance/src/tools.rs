//! Assistant tools. The host enforces the account's approval policy before a write tool arrives.
use crate::{accounts, input::Refusal, ledger};
use moss_module_sdk::{Error, Host, Response, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub tool: String,
    #[serde(default)]
    pub parameters: Value,
}

/// A refusal leaves as plain data holding a code and a fixed message, never the request text.
pub fn refusal(refusal: &Refusal) -> Value {
    json!({"status":"error","code":refusal.code,"message":refusal.message})
}
pub fn status(refusal: &Refusal) -> u16 {
    match refusal.code {
        "manual_conflict" | "manual_reconciled_period" => 409,
        "manual_unavailable" => 404,
        _ => 400,
    }
}
fn settle(outcome: ledger::Outcome) -> Value {
    outcome.unwrap_or_else(|r| refusal(&r))
}

pub fn execute<H: Host + ?Sized>(host: &H, request: Request) -> Result<Value> {
    match request.tool.as_str() {
        "finance.accounts.list" => accounts::list(host),
        "finance.manual.context" => accounts::context(host),
        "finance.manual.account-create" => Ok(settle(ledger::create_account(host, &request.parameters)?)),
        "finance.manual.entry-create" => Ok(settle(ledger::create_entry(host, &request.parameters)?)),
        _ => Err(Error::new("Unknown Finance tool")),
    }
}

/// A route answers with the outcome of the same code the tool runs.
pub fn route_write(outcome: Result<ledger::Outcome>) -> Result<Response> {
    Ok(match outcome? {
        Ok(body) => Response::new(200, body),
        Err(r) => Response::new(status(&r), refusal(&r)),
    })
}
