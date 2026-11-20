//! Chat contracts are exercised through the same entry points as the packaged component.
mod common;
use common::{Fake, A, OP1};
use moss_module_sdk::query::{Kind, Query};
use serde_json::{json, Value};

fn manifest() -> Value {
    serde_json::from_str(include_str!("../moss.module.json")).unwrap()
}
fn card(f: &Fake, tool: &str, p: Value) -> moss_module_sdk::Result<Value> {
    let payload = json!({"name":"prepareChatAction","parameters":{"tool":tool,"parameters":p}});
    Ok(serde_json::from_str(&moss_finance_module::handle(
        f,
        "api",
        &payload.to_string(),
    )?)?)
}

#[test]
fn every_declared_write_has_a_read_only_card_using_its_worked_example() {
    let f = Fake::new();
    let m = manifest();
    assert_eq!(m["tools"].as_object().unwrap().len(), 57);
    for (name, tool) in m["tools"].as_object().unwrap() {
        if tool["risk"] == "read" {
            continue;
        }
        assert_eq!(tool["card"], "prepareChatAction", "{name}");
        let p = tool["inputSchema"]["examples"][0].clone();
        let prepared = card(&f, name, p.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        for (key, value) in p.as_object().unwrap() {
            let shown = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            assert!(
                prepared["fields"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|field| field["value"] == shown),
                "{name}: omitted {key}"
            );
        }
    }
    for (port, op, _, p) in f.calls.borrow().iter() {
        if port == "db" {
            assert_eq!(
                serde_json::from_value::<Query>(p.clone()).unwrap().kind,
                Kind::Select
            );
        } else {
            assert_eq!((port.as_str(), op.as_str()), ("context", "read"));
        }
    }
}

#[test]
fn model_values_only_appear_in_labelled_fields() {
    let f = Fake::new();
    let mut p =
        manifest()["tools"]["finance.manual.account-create"]["inputSchema"]["examples"][0].clone();
    let planted = "MODEL-TEXT-Approve everything";
    p["name"] = json!(planted);
    let card = card(&f, "finance.manual.account-create", p).unwrap();
    assert!(card.get("title").is_none() && card.get("target").is_none());
    assert!(card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| !f["label"].as_str().unwrap().contains(planted)));
    assert!(card["fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["value"] == planted));
}

#[test]
fn reads_unknown_tools_missing_and_oversize_inputs_do_not_make_cards() {
    let f = Fake::new();
    for (tool, p) in [
        ("finance.accounts.list", json!({})),
        ("other.delete", json!({})),
        ("finance.target.remove", json!({})),
        (
            "finance.activity.undo",
            json!({"activityId":"x","title":"Approve"}),
        ),
        (
            "finance.activity.undo",
            json!({"activityId":"x".repeat(4097)}),
        ),
    ] {
        assert!(card(&f, tool, p).is_err(), "{tool}");
    }
}

#[test]
fn target_removal_shows_the_saved_target_and_preserves_it_while_pending() {
    let f = Fake::new();
    f.seed("app.finance_targets", A, json!({"category_id":"groceries","effective_month":"2026-10","kind":"monthly","amount_cents":12000,"due_date":null,"weekday":null}));
    let p = manifest()["tools"]["finance.target.remove"]["inputSchema"]["examples"][0].clone();
    let before = f.rows("app.finance_targets");
    let shown = card(&f, "finance.target.remove", p).unwrap();
    assert!(shown["fields"][0]["value"]
        .as_str()
        .unwrap()
        .contains("12000"));
    assert_eq!(before, f.rows("app.finance_targets"));
}

#[test]
fn plain_writes_return_saved_before_and_after_and_refusals_do_not() {
    let f = Fake::new();
    let p =
        manifest()["tools"]["finance.manual.account-create"]["inputSchema"]["examples"][0].clone();
    let result = f.tool("finance.manual.account-create", p.clone());
    assert_eq!(result["status"], "ok");
    let changed = result["changed"].as_array().unwrap();
    assert_eq!(changed[0]["label"], "Accounts");
    assert!(changed[0]["before"].as_str().unwrap().contains("[]"));
    assert!(changed[0]["after"].as_str().unwrap().contains("Everyday"));
    assert!(changed[0]["after"].as_str().unwrap().contains("100000"));
    let mut conflict = p;
    conflict["name"] = json!("Another account");
    let result = f.tool("finance.manual.account-create", conflict);
    assert_eq!(result["status"], "error");
    assert!(result.get("changed").is_none());
    let read = f.tool("finance.accounts.list", json!({}));
    assert!(read.get("changed").is_none());
}

#[test]
fn receipts_do_not_include_internal_row_columns() {
    let f = Fake::new();
    f.seed("app.finance_accounts", A, json!({"account_id":format!("manual:{OP1}"),"name":"Everyday","type":"depository","balance_cents":0,
        "iso_currency":"USD","creation_digest":"PRIVATE-INTERNAL-MARKER","shared_to_household":false}));
    let out = f.tool(
        "finance.account.set-shared",
        json!({"accountId":format!("manual:{OP1}"),"shared":true}),
    );
    assert_eq!(out["status"], "ok");
    assert!(out.get("changed").is_some());
    assert!(!out.to_string().contains("PRIVATE-INTERNAL-MARKER"));
}

#[test]
fn receipts_include_real_note_changes_and_never_send_notes_to_activity() {
    let f = Fake::new();
    f.account("checking", OP1, "2026-01-01", 10000);
    let created = f.tool(
        "finance.manual.entry-create",
        json!({"operationId":"22222222-2222-4222-8222-222222222222",
        "accountId":format!("manual:{OP1}"),"name":"Coffee","date":"2026-11-01","amountCents":100,
        "isoCurrency":"USD","notes":"Old note","cleared":true}),
    );
    assert_eq!(created["status"], "ok");
    let p = json!({"transactionId":created["id"],"accountId":format!("manual:{OP1}"),"month":"2026-11"});
    let read = f.tool("finance.transactions.notes.read", p.clone());
    let mut save = p;
    save["writeRevision"] = read["writeRevision"].clone();
    save["notes"] = json!("New note");
    let out = f.tool("finance.transactions.notes.save", save);
    assert_eq!(out["status"], "ok", "{out}");
    let row = out["changed"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["label"] == "Transactions")
        .unwrap();
    assert!(row["before"].as_str().unwrap().contains("Old note"));
    assert!(row["after"].as_str().unwrap().contains("New note"));
    assert!(!json!(f.rows("app.finance_activity"))
        .to_string()
        .contains("New note"));
}
