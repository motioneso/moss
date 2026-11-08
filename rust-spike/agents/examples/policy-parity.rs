//! Runs the Rust permission policy over the shared cases. Usage: policy-parity cases.json
use std::path::PathBuf;

use moss_agents::policy::{classify, Folders, Request};
use serde_json::Value;

fn main() {
    let path = std::env::args().nth(1).expect("cases.json");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let out: Vec<_> = cases
        .iter()
        .map(|c| {
            let cwd = PathBuf::from(c["cwd"].as_str().unwrap());
            let home = c["home"].as_str().map(PathBuf::from);
            let locations: Vec<String> = c["locations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap().to_string())
                .collect();
            classify(
                &Request {
                    tool_name: c["tool"].as_str(),
                    raw_input: &c["raw"],
                    locations: &locations,
                },
                &Folders {
                    cwd: &cwd,
                    home: home.as_deref(),
                },
            )
        })
        .collect();
    println!("{}", serde_json::to_string(&out).unwrap());
}
