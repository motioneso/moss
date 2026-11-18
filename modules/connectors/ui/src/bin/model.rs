use moss_connectors_ui::{model, views::AccountList};
use leptos::prelude::*;
use serde_json::{json, Value};
use std::io::{self, BufRead};

fn main() {
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let out = match v["operation"].as_str().unwrap() {
            "health" => json!(model::health_label(model::health(&v["account"])).0),
            "list" => {
                let accounts: Vec<(Value, Value)> = v["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| (a.clone(), v["grants"][a["id"].as_str().unwrap()].clone()))
                    .collect();
                json!(view! {<AccountList accounts busy=Signal::derive(|| false)
                    on_switch=Callback::new(|_| {}) on_revoke=Callback::new(|_| {})/>}.to_html())
            }
            _ => json!(null),
        };
        println!("{out}");
    }
}
