//! Ported from the legacy chunking unit tests. They pin the splitter, not the model.
use moss_backtrack_module::chunking::{estimate_tokens, split_segment_text, CHUNK_TOKEN_BUDGET};

fn joined(chunks: &[moss_backtrack_module::chunking::TextChunk], sep: &str) -> String {
    chunks.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(sep)
}

#[test]
fn keeps_a_short_segment_in_one_chunk_title_and_address_first() {
    let chunks = split_segment_text("A page", Some("https://example.test/a"), "hello world");
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].text, "A page\nhttps://example.test/a\nhello world");
}

#[test]
fn returns_nothing_for_an_empty_segment_and_skips_an_absent_address() {
    assert!(split_segment_text("", None, "   ").is_empty());
    assert_eq!(split_segment_text("T", None, "b")[0].text, "T\nb");
}

#[test]
fn splits_an_8kb_body_within_budget_and_loses_no_word() {
    let words: Vec<String> = (0..1400).map(|i| format!("word{i}")).collect();
    let full = words.join(" ");
    let body: String = full.chars().take(8192).collect();
    let chunks = split_segment_text("Title", Some("https://example.test"), &body);
    assert!(chunks.len() > 1);
    for c in &chunks {
        assert!(estimate_tokens(&c.text) <= CHUNK_TOKEN_BUDGET);
    }
    let all = joined(&chunks, " ");
    let parts: Vec<&str> = body.split(' ').collect();
    for w in &parts[..parts.len() - 1] {
        assert!(all.contains(w));
    }
}

#[test]
fn cuts_one_overlong_line_to_fit() {
    let blob = "a1b2c3d4".repeat(1000);
    let chunks = split_segment_text("", None, &blob);
    assert!(chunks.len() > 1);
    for c in &chunks {
        assert!(estimate_tokens(&c.text) <= CHUNK_TOKEN_BUDGET);
    }
    assert_eq!(joined(&chunks, ""), blob);
}

#[test]
fn budgets_cjk_text_tighter_than_prose() {
    let cjk = "日本語のテキスト".repeat(500);
    let chunks = split_segment_text("", None, &cjk);
    for c in &chunks {
        assert!(c.text.chars().count() <= CHUNK_TOKEN_BUDGET);
    }
    assert_eq!(joined(&chunks, ""), cjk);
}

#[test]
fn counts_a_one_letter_word_as_a_whole_token() {
    let body = "a ".repeat(615);
    assert_eq!(estimate_tokens(&body), 615);
    let chunks = split_segment_text("", None, &body);
    assert_eq!(chunks.len(), 2);
    for c in &chunks {
        assert!(estimate_tokens(&c.text) <= CHUNK_TOKEN_BUDGET);
    }
}

#[test]
fn weighs_a_character_by_the_code_points_it_decomposes_into() {
    assert_eq!(estimate_tokens("한국어"), 8);
    assert_eq!(estimate_tokens("İ"), 2);
    assert_eq!(estimate_tokens(" \n\t"), 0);
}

#[test]
fn never_splits_a_character_of_four_bytes() {
    let emoji = "😀".repeat(1200);
    let chunks = split_segment_text("", None, &emoji);
    assert_eq!(joined(&chunks, ""), emoji);
}

#[test]
fn does_not_treat_leading_dashes_or_hashes_as_structure() {
    let chunks = split_segment_text("", None, "---\nnot: frontmatter\n---\n## not a heading");
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].text.starts_with("---"));
}
