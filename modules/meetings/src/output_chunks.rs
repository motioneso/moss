//! Cuts long meeting evidence into ordered pieces whose prompts fit the model cap.
//! Offsets into notes are UTF-16 units, as in the old app.
use crate::output_validation::Inputs;
use serde_json::{json, Value};
use std::collections::HashSet;

const NOTES_SLICE: usize = 1000;

#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    /// Evidence shown to the model for this piece.
    pub inputs: Inputs,
    /// All evidence up to and including this piece. Piece answers are checked against it.
    pub seen: Inputs,
    pub notes_start: usize,
    pub notes_end: usize,
    pub segment_start: usize,
    pub segment_end: usize,
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn slice(inputs: &Inputs, notes: &[u16], ss: usize, se: usize, ns: usize, ne: usize) -> Inputs {
    Inputs {
        meeting_id: inputs.meeting_id.clone(),
        notes_revision: inputs.notes_revision,
        personal_notes: String::from_utf16_lossy(&notes[ns..ne]),
        segments: inputs.segments[ss..se].to_vec(),
    }
}

fn chunk(inputs: &Inputs, notes: &[u16], ss: usize, se: usize, ns: usize, ne: usize) -> Chunk {
    Chunk {
        inputs: slice(inputs, notes, ss, se, ns, ne),
        seen: slice(inputs, notes, 0, se, 0, ne),
        notes_start: ns,
        notes_end: ne,
        segment_start: ss,
        segment_end: se,
    }
}

/// `lastIndexOf` of one unit at or before `from`.
fn last_index(notes: &[u16], unit: u16, from: usize) -> Option<usize> {
    let top = from.min(notes.len().saturating_sub(1));
    notes.get(..=top)?.iter().rposition(|u| *u == unit)
}

/// End of the next notes slice, preferring a space or newline near the limit.
fn next_notes_end(notes: &[u16], start: usize) -> usize {
    if start + NOTES_SLICE >= notes.len() {
        return notes.len();
    }
    let limit = start + NOTES_SLICE;
    let boundary = [last_index(notes, 10, limit), last_index(notes, 32, limit)].into_iter().flatten().max();
    let mut end = match boundary {
        Some(b) if b > start => b + 1,
        _ => limit,
    };
    if (0xd800..0xdc00).contains(&notes[end - 1]) {
        end -= 1;
    }
    end
}

/// Whole segments are never cut. `fits` measures the real prompt for a candidate piece.
pub fn plan(inputs: &Inputs, fits: &mut dyn FnMut(&Inputs) -> bool) -> Vec<Chunk> {
    let notes = units(&inputs.personal_notes);
    let count = inputs.segments.len();
    if fits(inputs) {
        return vec![chunk(inputs, &notes, 0, count, 0, notes.len())];
    }
    let mut chunks = vec![];
    let (mut ss, mut ns) = (0, 0);
    while ss < count || ns < notes.len() {
        let (mut se, mut ne) = (ss, ns);
        let mut grew = true;
        while grew {
            grew = false;
            while se < count && fits(&slice(inputs, &notes, ss, se + 1, ns, ne)) {
                se += 1;
                grew = true;
            }
            while ne < notes.len() {
                let next = next_notes_end(&notes, ne);
                if !fits(&slice(inputs, &notes, ss, se, ns, next)) {
                    break;
                }
                ne = next;
                grew = true;
            }
        }
        if se == ss && ne == ns {
            // Nothing fits alone. Take one unit so the caller can cut it smaller or fail plainly.
            if se < count {
                se += 1;
            } else {
                ne = next_notes_end(&notes, ne);
            }
        }
        chunks.push(chunk(inputs, &notes, ss, se, ns, ne));
        ss = se;
        ns = ne;
    }
    chunks
}

/// Splits one piece in two, or returns None when it cannot be split.
pub fn split(inputs: &Inputs, piece: &Chunk) -> Option<(Chunk, Chunk)> {
    let notes = units(&inputs.personal_notes);
    let segments = piece.segment_end - piece.segment_start;
    if segments > 1 {
        let mid = piece.segment_start + segments / 2;
        return Some((
            chunk(inputs, &notes, piece.segment_start, mid, piece.notes_start, piece.notes_end),
            chunk(inputs, &notes, mid, piece.segment_end, piece.notes_start, piece.notes_end),
        ));
    }
    if piece.notes_end - piece.notes_start > NOTES_SLICE {
        let mid = next_notes_end(&notes, piece.notes_start);
        if mid >= piece.notes_end {
            return None;
        }
        return Some((
            chunk(inputs, &notes, piece.segment_start, piece.segment_end, piece.notes_start, mid),
            chunk(inputs, &notes, piece.segment_start, piece.segment_end, mid, piece.notes_end),
        ));
    }
    None
}

fn note_key(map: &serde_json::Map<String, Value>) -> Option<String> {
    if map.get("kind")?.as_str()? != "personal-note" {
        return None;
    }
    let meeting = map.get("meetingId")?.as_str()?;
    let numbers: Vec<&Value> = ["notesRevision", "startCharacter", "endCharacter"]
        .iter()
        .map(|k| map.get(*k).filter(|v| v.is_number()))
        .collect::<Option<_>>()?;
    Some(json!([meeting, numbers[0], numbers[1], numbers[2]]).to_string())
}

/// Keys of every notes citation already written in full-notes offsets.
pub fn note_citation_keys(value: &Value) -> HashSet<String> {
    fn visit(value: &Value, keys: &mut HashSet<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|v| visit(v, keys)),
            Value::Object(map) => {
                if let Some(key) = note_key(map) {
                    keys.insert(key);
                }
                map.values().for_each(|v| visit(v, keys));
            }
            _ => {}
        }
    }
    let mut keys = HashSet::new();
    visit(value, &mut keys);
    keys
}

/// Moves new notes citations from piece offsets back to full-notes offsets. Citations carried
/// over from the running summary already use full offsets, so `preserved` keeps them as they are.
pub fn shift_evidence(value: &Value, notes_start: usize, preserved: &HashSet<String>) -> Value {
    if notes_start == 0 {
        return value.clone();
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| shift_evidence(v, notes_start, preserved)).collect()),
        Value::Object(map) => {
            let shift = note_key(map).is_some_and(|key| !preserved.contains(&key));
            let mut out = serde_json::Map::new();
            for (key, item) in map {
                let item = if shift && (key == "startCharacter" || key == "endCharacter") {
                    json!(item.as_f64().unwrap_or(0.0) as i64 + notes_start as i64)
                } else {
                    shift_evidence(item, notes_start, preserved)
                };
                out.insert(key.clone(), item);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}
