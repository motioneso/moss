//! Compares the Rust parser with the actual legacy parseDocument vectors.
use moss_module_host::memory_parser::parse_document;
use serde_json::Value;

#[test]
fn parser_matches_legacy_vectors() {
    let rows = include_str!("data/memory-parser-vectors.jsonl");
    let mut count = 0;
    for line in rows.lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let input = row["input"].as_str().unwrap();
        let expected = &row["expected"];
        let got = parse_document(input);
        let actual = serde_json::json!({
            "frontmatterText": got.frontmatter_text,
            "wikilinks": got.wikilinks,
            "chunks": got.chunks.iter().map(|c| serde_json::json!({
                "text": c.text, "lineStart": c.line_start, "lineEnd": c.line_end
            })).collect::<Vec<_>>(),
        });
        assert_eq!(&actual, expected, "input {input:?}");
        count += 1;
    }
    assert!(count >= 400);
}

#[test]
fn empty_and_whitespace_documents_have_no_chunks() {
    assert!(parse_document("").chunks.is_empty());
    assert!(parse_document(" \n\t\n").chunks.is_empty());
}
