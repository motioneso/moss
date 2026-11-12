//! Runs one summary through the model, piece by piece. The model call is a trait so tests can
//! script it. In the package it is the host's `ai` port, which the router answers.
use crate::output_chunks::{note_citation_keys, plan, shift_evidence, split, Chunk};
use crate::output_prompt::{
    bytes, prompt, shrink_earlier_evidence, truncate_earlier_text, truncate_longest_text, PROMPT_MAX_BYTES,
};
use crate::output_validation::{validate, Content, Inputs};
use serde_json::Value;

/// A reply larger than this is refused unread.
const MAX_REPLY_BYTES: usize = 1_048_576;
const MAX_WARNINGS: usize = 50;
/// The route is chosen by the router, so the receipt records only that fact.
pub const MODEL_ROUTE: &str = "router:summarization";

pub enum ModelFail {
    TimedOut,
    Failed,
}

pub trait Model {
    fn generate(&self, prompt: &str) -> Result<String, ModelFail>;
}

#[derive(Debug, PartialEq)]
pub struct RunError {
    pub code: String,
    /// True for the one failure the route answers with 400 instead of a stored failure.
    pub bad_request: bool,
}
fn fail(code: &str) -> RunError {
    RunError { code: code.into(), bad_request: false }
}

pub struct Generated {
    pub content: Content,
    pub model_route: &'static str,
}

/// A fenced JSON block is accepted, because some routes wrap their answer.
fn parse_reply(reply: &str) -> Option<Value> {
    let trimmed = reply.trim();
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.trim_end().strip_suffix("```"))
        .unwrap_or(trimmed);
    serde_json::from_str(body.trim()).ok()
}

pub fn generate(
    model: &dyn Model,
    inputs: &Inputs,
    template_id: &str,
    template_version: i64,
    owner_context: Option<&Value>,
) -> Result<Generated, RunError> {
    let build = |piece: &Inputs, previous: Option<&Content>| prompt(piece, previous, template_id, template_version, owner_context);
    // Pieces target half the cap, which leaves room for the running summary in later prompts.
    let target = PROMPT_MAX_BYTES / 2;
    let chunks: Vec<Chunk> = if bytes(&build(inputs, None)) <= PROMPT_MAX_BYTES {
        plan(inputs, &mut |_| true)
    } else {
        plan(inputs, &mut |candidate| bytes(&build(candidate, None)) <= target)
    };
    let mut notes: Vec<String> = vec![];
    let mut note = |text: &str| {
        if !notes.iter().any(|n| n == text) {
            notes.push(text.into());
        }
    };
    let mut content: Option<Content> = None;
    let mut queue = chunks;
    let mut index = 0;
    while index < queue.len() {
        let mut piece = queue[index].clone();
        let mut piece_inputs = piece.inputs.clone();
        let mut previous = content.clone();
        let mut text = build(&piece_inputs, previous.as_ref());
        while bytes(&text) > PROMPT_MAX_BYTES {
            // Trim order: split the piece, earlier evidence, earlier text, the long text itself.
            if let Some((first, second)) = split(inputs, &piece) {
                queue.splice(index..=index, [first, second]);
                piece = queue[index].clone();
                piece_inputs = piece.inputs.clone();
            } else if let Some(shrunk) = previous.as_ref().and_then(shrink_earlier_evidence) {
                previous = Some(shrunk);
                note("Some earlier evidence references were shortened to fit.");
            } else if let Some(shorter) = previous.as_ref().and_then(truncate_earlier_text) {
                previous = Some(shorter);
                note("Part of the earlier summary text was cut to fit.");
            } else if let Some(cut) = truncate_longest_text(&piece_inputs) {
                piece_inputs = cut;
                note("Part of a very long passage was cut to fit, so this summary may miss it.");
            } else {
                return Err(RunError { code: "meeting_output_input_too_large".into(), bad_request: true });
            }
            text = build(&piece_inputs, previous.as_ref());
        }
        let mut piece_content: Option<Content> = None;
        for attempt in 0..2 {
            if piece_content.is_some() {
                break;
            }
            let reply = model.generate(&text).map_err(|e| match e {
                ModelFail::TimedOut => fail("meeting_output_timed_out"),
                ModelFail::Failed => fail("meeting_output_provider_failed"),
            })?;
            if reply.len() > MAX_REPLY_BYTES {
                if attempt == 0 {
                    continue;
                }
                return Err(fail("meeting_output_rejected_oversized_output"));
            }
            let Some(object) = parse_reply(&reply) else {
                if attempt == 0 {
                    continue;
                }
                return Err(fail("meeting_output_rejected_json_parse"));
            };
            let preserved = content.as_ref().map(|c| note_citation_keys(&serde_json::to_value(c).unwrap_or_default())).unwrap_or_default();
            let shifted = shift_evidence(&object, piece.notes_start, &preserved);
            match validate(&shifted, &piece.seen) {
                Ok(valid) => piece_content = Some(valid),
                Err(_) if attempt == 0 => continue,
                Err(reason) => return Err(fail(&format!("meeting_output_rejected_{}", reason.code()))),
            }
        }
        content = Some(piece_content.ok_or_else(|| fail("meeting_output_generation_failed"))?);
        index += 1;
    }
    let mut content = content.ok_or_else(|| fail("meeting_output_generation_failed"))?;
    let mut warnings: Vec<String> = vec![];
    for w in notes.into_iter().chain(content.warnings.iter().cloned()) {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    }
    warnings.truncate(MAX_WARNINGS);
    content.warnings = warnings;
    Ok(Generated { content, model_route: MODEL_ROUTE })
}
