//! Markdown note parser matching the legacy memory parser. All offsets and the
//! chunk budget are UTF-16 code units, as in the legacy implementation.

const MAX_CHUNK_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextChunk {
    pub text: String,
    pub line_start: usize,
    pub line_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDocument {
    pub frontmatter_text: String,
    pub wikilinks: Vec<String>,
    pub chunks: Vec<TextChunk>,
}

/// JavaScript `String.prototype.trim` whitespace and line terminators.
fn is_ws(c: u16) -> bool {
    matches!(
        c,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f
            | 0x3000 | 0xfeff
    )
}

fn trim(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|c| !is_ws(*c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !is_ws(*c)).map_or(start, |i| i + 1);
    &u[start..end]
}

fn text(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

fn newlines(u: &[u16]) -> usize {
    u.iter().filter(|c| **c == 0x0a).count()
}

fn lines(u: &[u16]) -> usize {
    newlines(u) + 1
}

fn at(u: &[u16], i: usize, s: &str) -> bool {
    let n = s.len();
    i + n <= u.len() && s.bytes().enumerate().all(|(k, b)| u[i + k] == u16::from(b))
}

/// `^---\r?\n([\s\S]*?)\r?\n---\r?\n?` : returns (group start, group end, match end).
fn frontmatter(u: &[u16]) -> Option<(usize, usize, usize)> {
    let mut start = 3;
    if !at(u, 0, "---") {
        return None;
    }
    if u.get(start) == Some(&0x0d) {
        start += 1;
    }
    if u.get(start) != Some(&0x0a) {
        return None;
    }
    start += 1;
    for k in start..=u.len() {
        let mut j = k;
        if u.get(j) == Some(&0x0d) {
            j += 1;
        }
        if u.get(j) != Some(&0x0a) || !at(u, j + 1, "---") {
            continue;
        }
        let mut end = j + 4;
        if u.get(end) == Some(&0x0d) {
            end += 1;
        }
        if u.get(end) == Some(&0x0a) {
            end += 1;
        }
        return Some((start, k, end));
    }
    None
}

/// `\[\[([^\]|]+)(?:\|[^\]]+)?\]\]` over the body.
fn wikilinks(u: &[u16]) -> Vec<String> {
    let mut links = Vec::new();
    let (bracket, close, pipe) = (0x5b, 0x5d, 0x7c);
    let mut i = 0;
    while i + 1 < u.len() {
        if u[i] != bracket || u[i + 1] != bracket {
            i += 1;
            continue;
        }
        let mut j = i + 2;
        while j < u.len() && u[j] != close && u[j] != pipe {
            j += 1;
        }
        let name = (i + 2, j);
        if name.0 == name.1 {
            i += 1;
            continue;
        }
        if u.get(j) == Some(&pipe) {
            let mut m = j + 1;
            while m < u.len() && u[m] != close {
                m += 1;
            }
            if m == j + 1 {
                i += 1;
                continue;
            }
            j = m;
        }
        if u.get(j) == Some(&close) && u.get(j + 1) == Some(&close) {
            links.push(text(trim(&u[name.0..name.1])));
            i = j + 2;
        } else {
            i += 1;
        }
    }
    links
}

/// `split(/(?=^## )/m)`: splits before each line start followed by `## `.
fn split_sections(u: &[u16]) -> Vec<&[u16]> {
    let mut parts = Vec::new();
    let mut last = 0;
    for q in 1..u.len() {
        if at(u, q, "## ") && matches!(u[q - 1], 0x0a | 0x0d | 0x2028 | 0x2029) {
            parts.push(&u[last..q]);
            last = q;
        }
    }
    parts.push(&u[last..]);
    parts
}

/// `split(/(?<=\n[ \t]*\n)/)`.
fn split_paragraphs(u: &[u16]) -> Vec<&[u16]> {
    let mut parts = Vec::new();
    let mut last = 0;
    for q in 1..u.len() {
        if u[q - 1] != 0x0a {
            continue;
        }
        let mut r = q - 1;
        while r > 0 && (u[r - 1] == 0x20 || u[r - 1] == 0x09) {
            r -= 1;
        }
        if r > 0 && u[r - 1] == 0x0a {
            parts.push(&u[last..q]);
            last = q;
        }
    }
    parts.push(&u[last..]);
    parts
}

/// `split(/(?<=\n)/)`.
fn split_lines(u: &[u16]) -> Vec<&[u16]> {
    let mut parts = Vec::new();
    let mut last = 0;
    for q in 1..u.len() {
        if u[q - 1] == 0x0a {
            parts.push(&u[last..q]);
            last = q;
        }
    }
    parts.push(&u[last..]);
    parts
}

fn split_to_budget(paragraph: &[u16]) -> Vec<Vec<u16>> {
    if paragraph.len() <= MAX_CHUNK_CHARS {
        return vec![paragraph.to_vec()];
    }
    let mut units = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    for line in split_lines(paragraph) {
        if line.len() > MAX_CHUNK_CHARS {
            if !current.is_empty() {
                units.push(std::mem::take(&mut current));
            }
            units.extend(line.chunks(MAX_CHUNK_CHARS).map(<[u16]>::to_vec));
            continue;
        }
        if !current.is_empty() && current.len() + line.len() > MAX_CHUNK_CHARS {
            units.push(std::mem::take(&mut current));
        }
        current.extend_from_slice(line);
    }
    if !current.is_empty() {
        units.push(current);
    }
    units
}

fn cap_chunk_size(section: &[u16]) -> Vec<Vec<u16>> {
    if section.len() <= MAX_CHUNK_CHARS {
        return vec![section.to_vec()];
    }
    let mut parts = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    for paragraph in split_paragraphs(section) {
        for unit in split_to_budget(paragraph) {
            if !current.is_empty() && current.len() + unit.len() > MAX_CHUNK_CHARS {
                parts.push(std::mem::take(&mut current));
            }
            current.extend_from_slice(&unit);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn split_into_chunks(full: &[u16], body: &[u16]) -> Vec<TextChunk> {
    let trimmed = trim(body);
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut running = lines(full) - lines(body);
    let mut chunks = Vec::new();
    for section in split_sections(trimmed)
        .into_iter()
        .filter(|s| !trim(s).is_empty())
    {
        let mut offset = 0;
        for part in cap_chunk_size(section) {
            let count = newlines(&part);
            let body = trim(&part);
            if !body.is_empty() {
                chunks.push(TextChunk {
                    text: text(body),
                    line_start: running + offset,
                    line_end: running + offset + count,
                });
            }
            offset += count;
        }
        running += lines(section);
    }
    chunks
}

pub fn parse_document(content: &str) -> ParsedDocument {
    let u: Vec<u16> = content.encode_utf16().collect();
    let (frontmatter_text, body) = match frontmatter(&u) {
        Some((start, end, matched)) => (text(&u[start..end]), &u[matched..]),
        None => (String::new(), &u[..]),
    };
    ParsedDocument {
        frontmatter_text,
        wikilinks: wikilinks(body),
        chunks: split_into_chunks(&u, body),
    }
}
