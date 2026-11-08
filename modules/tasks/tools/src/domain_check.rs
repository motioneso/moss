//! Executable used by the differential check, not part of the shipped guest.
use moss_tasks_module::recurrence;
use serde_json::{json, Value};
use std::io::Read;
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let input: Value = serde_json::from_str(&input).unwrap();
    let output:Vec<Value>=input.as_array().unwrap().iter().map(|item|{
        let spec=recurrence::parse(&item["spec"]);
        match spec {None=>Value::Null,Some(spec)=>json!({"parsed":spec.dto(),"next":spec.next(),"atOrAfter":spec.at_or_after(item["today"].as_str().unwrap())})}
    }).collect();
    println!("{}", serde_json::to_string(&output).unwrap());
}
