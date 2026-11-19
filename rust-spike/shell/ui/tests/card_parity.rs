use std::collections::BTreeSet;

/// Extract literal class attributes in either TSX or Leptos markup, without a second class list.
fn classes(source: &str, attribute: &str) -> BTreeSet<String> {
    source
        .split(attribute)
        .skip(1)
        .filter_map(|tail| tail.split('"').next())
        .flat_map(str::split_whitespace)
        .map(str::to_owned)
        .collect()
}

#[test]
fn approval_card_keeps_every_typescript_class() {
    let ts = include_str!("../../../../apps/web/src/chat/action-request-card.tsx");
    let rust = include_str!("../src/chat_cards.rs");
    let expected = classes(ts, "className=\"");
    assert!(expected.contains("action-request-preview__body"));
    let actual = classes(rust, "class=\"");
    // Summary shares a conditional class attribute in the port.
    let conditional = classes(rust, "{ \"");
    let actual: BTreeSet<_> = actual.union(&conditional).cloned().collect();
    let missing: Vec<_> = expected.difference(&actual).collect();
    assert!(
        missing.is_empty(),
        "TypeScript card classes missing from Rust: {missing:?}"
    );
}
