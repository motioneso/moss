//! Transcript ledger rules, ported from the TypeScript app. Pure logic, no host calls.
use crate::js::{cmp_utf16, utf16_len, MAX_SAFE};
use crate::text::js_trim;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_SEGMENTS: i64 = 500;
pub const MAX_CHARACTERS: i64 = 100_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub source_id: String,
    pub epoch: i64,
    pub kind: String,
    pub label: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub meeting_id: String,
    pub segment_id: String,
    pub source_id: String,
    pub epoch: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub revision: i64,
    pub text: String,
    pub finality: String,
    pub provenance: String,
    pub speaker_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub cursor: i64,
    pub segment: Segment,
}

#[derive(Clone, Debug)]
pub struct Revision {
    pub cursor: i64,
    pub segment: Segment,
    pub transcript_revision: i64,
}

/// A rejected event or source set. The routes map every variant to the same invalid-input answer.
#[derive(Debug, PartialEq)]
pub struct Rejected;

pub struct Ledger {
    pub meeting_id: String,
    pub owner_user_id: String,
    pub sources: Vec<Source>,
    pub transcript_revision: i64,
    pub cursor: i64,
    pub revisions: Vec<Revision>,
    by_segment: HashMap<String, Vec<usize>>,
}

fn integer(value: i64, minimum: i64) -> bool {
    value.abs() <= MAX_SAFE && value >= minimum
}
fn identifier(value: &str) -> bool {
    !js_trim(value).is_empty()
}

impl Ledger {
    pub fn new(meeting_id: &str, owner: &str, sources: &[Source]) -> Result<Self, Rejected> {
        check_sources(meeting_id, owner, sources)?;
        Ok(Self {
            meeting_id: meeting_id.into(),
            owner_user_id: owner.into(),
            sources: sources.to_vec(),
            transcript_revision: 0,
            cursor: 0,
            revisions: vec![],
            by_segment: HashMap::new(),
        })
    }

    /// A ledger rebuilt from stored history, which was validated when it was accepted.
    pub fn restored(meeting_id: &str, owner: &str, sources: Vec<Source>) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            owner_user_id: owner.into(),
            sources,
            transcript_revision: 0,
            cursor: 0,
            revisions: vec![],
            by_segment: HashMap::new(),
        }
    }

    /// Monotonic extension of the captured bounds. Identity and old bounds cannot change.
    pub fn extend_sources(&mut self, sources: &[Source]) -> Result<(), Rejected> {
        check_sources(&self.meeting_id, &self.owner_user_id, sources)?;
        for previous in &self.sources {
            let next = sources
                .iter()
                .find(|s| s.source_id == previous.source_id && s.epoch == previous.epoch)
                .ok_or(Rejected)?;
            if next.start_ms != previous.start_ms
                || next.kind != previous.kind
                || next.label != previous.label
                || next.end_ms < previous.end_ms
            {
                return Err(Rejected);
            }
        }
        let latest = self.sources.iter().map(|s| s.epoch).max().unwrap_or(0);
        for source in sources {
            let known = self
                .sources
                .iter()
                .any(|p| p.source_id == source.source_id && p.epoch == source.epoch);
            if !known && source.epoch < latest {
                return Err(Rejected);
            }
        }
        self.sources = sources.to_vec();
        Ok(())
    }

    /// Appends a revision straight from stored history, which was validated when accepted.
    pub fn push_stored(&mut self, event: &Event) {
        let index = self.revisions.len();
        self.by_segment
            .entry(event.segment.segment_id.clone())
            .or_default()
            .push(index);
        self.cursor = event.cursor;
        self.transcript_revision += 1;
        self.revisions.push(Revision {
            cursor: event.cursor,
            segment: event.segment.clone(),
            transcript_revision: self.transcript_revision,
        });
    }

    /// Outcome of one event. `Ok(true)` was accepted and `Ok(false)` was an exact replay.
    pub fn apply(&mut self, event: &Event) -> Result<bool, Rejected> {
        let segment = &event.segment;
        if !integer(event.cursor, 1) || !valid_segment(segment) {
            return Err(Rejected);
        }
        if segment.meeting_id != self.meeting_id {
            return Err(Rejected);
        }
        let in_source = self.sources.iter().any(|s| {
            s.source_id == segment.source_id
                && s.epoch == segment.epoch
                && segment.start_ms >= s.start_ms
                && segment.end_ms <= s.end_ms
        });
        if !in_source {
            return Err(Rejected);
        }
        let history = self.by_segment.get(&segment.segment_id);
        let existing = history
            .into_iter()
            .flatten()
            .map(|i| &self.revisions[*i])
            .find(|r| r.segment.revision == segment.revision);
        if let Some(existing) = existing {
            return if existing.cursor == event.cursor && existing.segment == *segment {
                Ok(false)
            } else {
                Err(Rejected)
            };
        }
        let previous = history.and_then(|h| h.last()).map(|i| &self.revisions[*i].segment);
        if previous.is_some_and(|p| segment.revision < p.revision) {
            return Err(Rejected);
        }
        if event.cursor <= self.cursor {
            return Err(Rejected);
        }
        if previous.is_some_and(|p| p.source_id != segment.source_id || p.epoch != segment.epoch) {
            return Err(Rejected);
        }
        if previous.is_some_and(|p| p.finality == "final")
            && (segment.finality != "final" || segment.provenance != "correction")
        {
            return Err(Rejected);
        }
        self.push_stored(event);
        Ok(true)
    }
}

fn check_sources(meeting_id: &str, owner: &str, sources: &[Source]) -> Result<(), Rejected> {
    if !identifier(meeting_id) || !identifier(owner) || sources.is_empty() {
        return Err(Rejected);
    }
    let mut keys = std::collections::HashSet::new();
    for s in sources {
        if !identifier(&s.source_id)
            || !identifier(&s.label)
            || !integer(s.epoch, 1)
            || !integer(s.start_ms, 0)
            || !integer(s.end_ms, 0)
            || s.end_ms <= s.start_ms
            || !matches!(s.kind.as_str(), "microphone" | "output" | "recording")
            || !keys.insert((s.source_id.as_str(), s.epoch))
        {
            return Err(Rejected);
        }
    }
    for s in sources {
        let clash = sources.iter().any(|p| {
            p.epoch < s.epoch
                && (p.end_ms > s.start_ms || (p.source_id == s.source_id && p.kind != s.kind))
        });
        if clash {
            return Err(Rejected);
        }
    }
    Ok(())
}

fn valid_segment(s: &Segment) -> bool {
    identifier(&s.meeting_id)
        && identifier(&s.segment_id)
        && identifier(&s.source_id)
        && integer(s.epoch, 1)
        && integer(s.revision, 1)
        && integer(s.start_ms, 0)
        && integer(s.end_ms, 0)
        && s.end_ms > s.start_ms
        && utf16_len(&s.text) as i64 <= MAX_CHARACTERS
        && matches!(s.finality.as_str(), "provisional" | "final")
        && matches!(s.provenance.as_str(), "transcription" | "correction")
        && (s.provenance != "correction" || s.finality == "final")
        && s.speaker_id.as_deref().is_none_or(identifier)
}

pub struct Snapshot {
    pub cursor: i64,
    pub segments: Vec<Segment>,
    pub through_ms: Option<i64>,
    pub omitted: usize,
    pub contains_provisional: bool,
}

/// Whole segments that end at or before the cutoff, in time order. Never truncates text.
pub fn snapshot(
    ledger: &Ledger,
    transcript_revision: i64,
    cutoff_ms: i64,
    max_segments: i64,
    max_characters: i64,
) -> Result<Snapshot, Rejected> {
    snapshot_within(ledger, transcript_revision, cutoff_ms, max_segments, max_characters, (MAX_SEGMENTS, MAX_CHARACTERS))
}

/// Same as `snapshot`, with a higher ceiling for long recordings, which summaries read in pieces.
pub fn snapshot_within(
    ledger: &Ledger,
    transcript_revision: i64,
    cutoff_ms: i64,
    max_segments: i64,
    max_characters: i64,
    ceiling: (i64, i64),
) -> Result<Snapshot, Rejected> {
    if transcript_revision > ledger.transcript_revision
        || !(1..=ceiling.0).contains(&max_segments)
        || !(1..=ceiling.1).contains(&max_characters)
    {
        return Err(Rejected);
    }
    let mut latest: HashMap<&str, &Segment> = HashMap::new();
    let mut cursor = 0;
    for r in &ledger.revisions {
        if r.transcript_revision > transcript_revision {
            break;
        }
        latest.insert(&r.segment.segment_id, &r.segment);
        cursor = r.cursor;
    }
    let mut eligible: Vec<&Segment> = latest.into_values().filter(|s| s.end_ms <= cutoff_ms).collect();
    eligible.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then(a.end_ms.cmp(&b.end_ms))
            .then_with(|| cmp_utf16(&a.segment_id, &b.segment_id))
    });
    let mut segments: Vec<Segment> = vec![];
    let mut characters = 0i64;
    for s in &eligible {
        let size = utf16_len(&s.text) as i64;
        if segments.len() as i64 == max_segments || characters + size > max_characters {
            break;
        }
        segments.push((*s).clone());
        characters += size;
    }
    Ok(Snapshot {
        cursor,
        through_ms: segments.iter().map(|s| s.end_ms).max(),
        omitted: eligible.len() - segments.len(),
        contains_provisional: segments.iter().any(|s| s.finality == "provisional"),
        segments,
    })
}

/// The pinned revision's text between two UTF-16 offsets. A cut inside a surrogate pair is refused.
pub fn evidence(
    ledger: &Ledger,
    segment_id: &str,
    revision: i64,
    start: i64,
    end: i64,
) -> Option<(Segment, String)> {
    if revision < 1 || start < 0 || end <= start {
        return None;
    }
    let found = ledger
        .revisions
        .iter()
        .find(|r| r.segment.segment_id == segment_id && r.segment.revision == revision)?;
    let units: Vec<u16> = found.segment.text.encode_utf16().collect();
    if end as usize > units.len() {
        return None;
    }
    let splits = |at: usize| {
        at > 0
            && at < units.len()
            && (0xd800..0xdc00).contains(&units[at - 1])
            && (0xdc00..0xe000).contains(&units[at])
    };
    if splits(start as usize) || splits(end as usize) {
        return None;
    }
    let excerpt = String::from_utf16(&units[start as usize..end as usize]).ok()?;
    Some((found.segment.clone(), excerpt))
}
