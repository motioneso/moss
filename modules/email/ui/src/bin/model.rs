use leptos::prelude::*;
use moss_email_ui::{model, views::SettingsForm};
use serde_json::{json, Value};
use std::io::{self, BufRead};

fn main() {
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let out = match v["operation"].as_str().unwrap() {
            "save" => json!(model::save_request(v["key"].as_str().unwrap(), &v["value"])),
            "form" => {
                let settings = v["settings"].clone();
                json!(view! {<SettingsForm settings busy=Signal::derive(|| false)
                    on_change=Callback::new(|_| {})/>}.to_html())
            }
            _ => json!(null),
        };
        println!("{out}");
    }
}
