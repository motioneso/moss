//! Splits one screen segment into chunks the embedder can read whole.
//!
//! The embedder reads at most 512 tokens and silently drops the rest. A segment holds up to 8 KB
//! plus a title and address, so it is split here. Every chunk of a segment shares the segment's
//! source path.
//!
//! The model's tokenizer lowercases and decomposes (NFD) the text, splits it at whitespace,
//! punctuation and CJK characters, then cuts each word into pieces of at least one code point.
//! No token spans whitespace, so the tokens in a text are at most its non-whitespace code points
//! once lowercased and decomposed. A chunk may weigh at most `CHUNK_TOKEN_BUDGET`, which is 512
//! less the six tokens of the document wrapper and a small margin.
use unicode_normalization::UnicodeNormalization;

pub const CHUNK_TOKEN_BUDGET: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextChunk {
    pub text: String,
    pub line_start: usize,
    pub line_end: usize,
}

/// Whitespace as the legacy splitter saw it (the byte order mark counts).
fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn char_weight(c: char) -> usize {
    if is_space(c) {
        return 0;
    }
    // Both orders, since a lowercase can add code points and so can a decomposition.
    let lower_first = c.to_lowercase().nfd().count();
    let decompose_first = c.to_string().nfd().collect::<String>().to_lowercase().chars().count();
    lower_first.max(decompose_first)
}

/// An upper bound on the tokens the embedder makes of `text`.
pub fn estimate_tokens(text: &str) -> usize {
    text.chars().map(char_weight).sum()
}

/// Cuts one over-budget run into pieces that each fit, at spaces where it can and mid-word only
/// when it must.
fn cut_to_budget(run: &str) -> Vec<String> {
    struct Cut {
        pieces: Vec<String>,
        current: String,
        weight: usize,
    }
    impl Cut {
        fn push(&mut self, text: &str, text_weight: usize) {
            if !self.current.is_empty() && self.weight + text_weight > CHUNK_TOKEN_BUDGET {
                self.pieces.push(std::mem::take(&mut self.current));
                self.weight = 0;
            }
            self.current.push_str(text);
            self.weight += text_weight;
        }
    }
    let mut cut = Cut { pieces: Vec::new(), current: String::new(), weight: 0 };
    for word in run.split_inclusive(is_space) {
        let word_weight = estimate_tokens(word);
        if word_weight <= CHUNK_TOKEN_BUDGET {
            cut.push(word, word_weight);
            continue;
        }
        // One unbroken run (a minified blob, a long hash) longer than a whole chunk.
        for c in word.chars() {
            let mut buffer = [0u8; 4];
            cut.push(c.encode_utf8(&mut buffer), char_weight(c));
        }
    }
    if !cut.current.is_empty() {
        cut.pieces.push(cut.current);
    }
    cut.pieces
}

fn trimmed(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// Title, address and body joined by newlines, then split into chunks that each fit the embedder.
/// Whole lines stay together where they fit, and a line that does not fit is cut. The chunks
/// reproduce the joined text apart from trimmed edge whitespace. Line numbers count from zero in
/// the joined text. Empty parts are skipped and an all-empty segment yields no chunk.
pub fn split_segment_text(window_title: &str, address: Option<&str>, body: &str) -> Vec<TextChunk> {
    let joined = [window_title, address.unwrap_or(""), body]
        .into_iter()
        .filter(|part| !trimmed(part).is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if trimmed(&joined).is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_weight = 0;
    let mut start_line = 0;
    let mut line = 0;

    // `end_line` is the line the next text starts on, one past this chunk when it ends in a newline.
    let flush = |current: &mut String, start_line: usize, end_line: usize, chunks: &mut Vec<TextChunk>| {
        let text = trimmed(current).to_owned();
        let line_end = start_line.max(if current.ends_with('\n') { end_line.saturating_sub(1) } else { end_line });
        if !text.is_empty() {
            chunks.push(TextChunk { text, line_start: start_line, line_end });
        }
        current.clear();
    };

    for unit in joined.split_inclusive('\n') {
        let pieces = if estimate_tokens(unit) > CHUNK_TOKEN_BUDGET { cut_to_budget(unit) } else { vec![unit.to_owned()] };
        for piece in pieces {
            let weight = estimate_tokens(&piece);
            if !current.is_empty() && current_weight + weight > CHUNK_TOKEN_BUDGET {
                flush(&mut current, start_line, line, &mut chunks);
                current_weight = 0;
            }
            if current.is_empty() {
                start_line = line;
            }
            current.push_str(&piece);
            current_weight += weight;
        }
        if unit.ends_with('\n') {
            line += 1;
        }
    }
    flush(&mut current, start_line, line, &mut chunks);
    chunks
}
