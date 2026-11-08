//! Exact recording-owned blocks. Receipts, rather than a whole-file snapshot, own these bytes.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};

const MAX_BYTES: usize = 16 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    pub bytes: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Observation {
    Missing,
    Unchanged,
    Conflict,
}
fn markers(id: &str) -> Result<(String, String, String)> {
    if !crate::identity::hex_digest(id) {
        return Err(Error("Invalid recording block identity".into()));
    }
    let prefix = format!("<!-- moss-recording:v1:{id}:");
    Ok((
        format!("{prefix}begin -->"),
        format!("{prefix}end -->"),
        prefix,
    ))
}
fn conflict<T>() -> Result<T> {
    Err(Error(
        "The recording's note block is missing, duplicated or changed; review current content"
            .into(),
    ))
}

pub fn render(id: &str, text: &str) -> Result<Block> {
    let (begin, end, _) = markers(id)?;
    // Rust strings cannot contain the unpaired UTF-16 surrogates rejected by the TS API.
    if text.chars().all(js_whitespace) || text.len() > MAX_BYTES {
        return Err(Error(
            "A note contribution requires 1 to 16384 UTF-8 bytes".into(),
        ));
    }
    let escaped = text.replace("<!--", "&lt;!--");
    if escaped.len() > MAX_BYTES {
        return Err(Error(
            "Escaped note contribution exceeds 16384 UTF-8 bytes".into(),
        ));
    }
    Ok(Block {
        id: id.into(),
        bytes: format!("\n{begin}\n{escaped}\n{end}\n"),
    })
}
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn inspect(note: &str, block: &Block) -> Result<Observation> {
    let (begin, end, prefix) = markers(&block.id)?;
    let count = note.matches(&prefix).count();
    Ok(if count == 0 {
        Observation::Missing
    } else if count != 2
        || note.matches(&begin).count() != 1
        || note.matches(&end).count() != 1
        || !note.contains(&block.bytes)
    {
        Observation::Conflict
    } else {
        Observation::Unchanged
    })
}
pub fn append(note: &str, block: &Block) -> Result<String> {
    match inspect(note, block)? {
        Observation::Conflict => conflict(),
        Observation::Unchanged => Ok(note.into()),
        Observation::Missing => Ok(format!("{note}{}", block.bytes)),
    }
}
pub fn change(note: &str, before: &Block, after: Option<&Block>) -> Result<String> {
    if after.is_some_and(|a| a.id != before.id) {
        return Err(Error("A note change must retain its block identity".into()));
    }
    if inspect(note, before)? != Observation::Unchanged {
        return conflict();
    }
    let at = note.find(&before.bytes).expect("inspected block");
    let prefix = &note[..at];
    let suffix = &note[at + before.bytes.len()..];
    let boundary = if !prefix.is_empty()
        && !suffix.is_empty()
        && !prefix.ends_with('\n')
        && !suffix.starts_with('\n')
    {
        "\n"
    } else {
        ""
    };
    Ok(format!(
        "{prefix}{}{suffix}",
        after.map(|a| a.bytes.as_str()).unwrap_or(boundary)
    ))
}
pub fn cleanup(note: &str, variants: &[Block]) -> Result<String> {
    let first = variants
        .first()
        .ok_or_else(|| Error("Cleanup needs exact variants of one source-owned block".into()))?;
    if variants.iter().any(|b| b.id != first.id) {
        return Err(Error(
            "Cleanup needs exact variants of one source-owned block".into(),
        ));
    }
    for block in variants {
        if inspect(note, block)? == Observation::Unchanged {
            return change(note, block, None);
        }
    }
    if inspect(note, first)? == Observation::Missing {
        Ok(note.into())
    } else {
        conflict()
    }
}
#[derive(Debug, Serialize)]
pub struct Reconciled {
    pub content: String,
    pub status: &'static str,
}
/// Only call for a receipt's durable pending intent, never an already-applied receipt replay.
pub fn reconcile(note: &str, before: Option<&Block>, after: Option<&Block>) -> Result<Reconciled> {
    if before.is_none() && after.is_none() {
        return Err(Error("A note operation needs a source block".into()));
    }
    if let (Some(b), Some(a)) = (before, after) {
        if b.id != a.id {
            return Err(Error(
                "A note operation must retain its block identity".into(),
            ));
        }
    }
    if let Some(after) = after {
        if inspect(note, after)? == Observation::Unchanged {
            return Ok(Reconciled {
                content: note.into(),
                status: "already_published",
            });
        }
    }
    let content = if let Some(before) = before {
        let current = inspect(note, before)?;
        if after.is_none() && current == Observation::Missing {
            return Ok(Reconciled {
                content: note.into(),
                status: "already_published",
            });
        }
        if current != Observation::Unchanged {
            return conflict();
        }
        change(note, before, after)?
    } else {
        append(note, after.expect("checked operation"))?
    };
    Ok(Reconciled {
        content,
        status: "changed",
    })
}
