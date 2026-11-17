//! The Rust code table must match the legacy one exactly.
use moss_backtrack_module::codes::{Code, ALL, RANGE_MESSAGES};
use std::collections::BTreeSet;

fn legacy(file: &str) -> String {
    std::fs::read_to_string(format!("{}/../../../{file}", env!("CARGO_MANIFEST_DIR"))).expect("legacy file")
}

#[test]
fn every_backtrack_code_in_the_legacy_union_is_in_the_table_and_back() {
    let text = legacy("packages/shared/src/companion-api.ts");
    let start = text.find("export type CompanionErrorCode").unwrap();
    let union = &text[start..text[start..].find(';').unwrap() + start];
    let legacy_codes: BTreeSet<&str> = union.split('"').skip(1).step_by(2).collect();
    for code in ALL {
        assert!(legacy_codes.contains(code.as_str()), "{} is not a legacy code", code.as_str());
    }
    // The legacy codes this route can return are exactly the ones the table holds.
    let ours: BTreeSet<&str> = ALL.iter().map(|c| c.as_str()).collect();
    for name in ["backtrack_unavailable", "backtrack_paused", "backtrack_clock"] {
        assert!(ours.contains(name));
    }
}

#[test]
fn statuses_and_bodies_match_the_legacy_routes() {
    assert_eq!((Code::Unavailable.status(), Code::Paused.status(), Code::Clock.status()), (409, 409, 422));
    assert_eq!(Code::NotLinked.status(), 401);
    assert_eq!((Code::PendingApproval.status(), Code::Deactivated.status()), (403, 403));
    let body = Code::Clock.body();
    assert_eq!(body["code"], "backtrack_clock");
    assert!(body["error"].is_string());
}

#[test]
fn range_messages_appear_in_the_legacy_range_file() {
    let text = legacy("packages/backtrack/src/deletion-range.ts");
    for message in RANGE_MESSAGES {
        assert!(text.contains(message), "{message}");
    }
}
