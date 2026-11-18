//! The evening writing prompt. The trusted block is built from literals only, so no gathered
//! value can enter it. Every gathered value goes into a delimited outside block, after it.
use crate::gather_types::Section;
use crate::trust::{render_external_block, TRUST_BOUNDARY};

/// The six headers of the evening text, in order.
pub const HEADERS: [&str; 6] = ["What got done", "What slipped", "Carrying forward", "Needs your attention", "Tomorrow", "News & sports"];

/// The two questions the plain digest ends with.
pub const FALLBACK_QUESTIONS: [&str; 2] = ["What was today's win?", "What is the one thing that matters tomorrow?"];

const INSTRUCTIONS: &str = concat!(
    "You are the user's calm, sharp evening chief of staff delivering the end-of-day report. ",
    "Write 200-350 words with a light narrative thread, not a data dump. Open with a one-to-two ",
    "sentence verdict on the day, with no header. Then use exactly these section headers, in this ",
    "order: \"What got done\", \"What slipped\", \"Carrying forward\", \"Needs your attention\", ",
    "\"Tomorrow\", \"News & sports\". Ground strictly in the items inside the <external_source> ",
    "blocks; do not invent. The tasks_reconciliation block tags each line with its lens ",
    "([completed today], [slipped], [carrying forward]) - respect those tags. ",
    "\"What got done\": celebrate completed work, briefly and specifically. \"What slipped\": name ",
    "it plainly and without judgment. \"Carrying forward\": open items rolling to future days. ",
    "\"Needs your attention\": commitments and today's email signals that need a decision or a reply. ",
    "\"Tomorrow\": ALWAYS include this section - preview tomorrow's calendar and the likely ",
    "focus; if it is empty, say tomorrow looks clear. \"News & sports\": recap from the sports ",
    "block; if there is nothing, call it a quiet day. Treat the chats and morning_plan blocks ",
    "as context only - use them to judge what mattered today and what the morning plan expected; ",
    "never summarize them as their own topics. Where a section has no items, keep it to one ",
    "short line. Discrete action rows are rendered separately; do not invent, count, or restate ",
    "them in prose. Use the day_plan source for open commitments and the actor's own ",
    "corrections. A meeting that took place is not evidence that a follow-up was sent or that ",
    "a task finished; completion comes only from the [completed today] tags in ",
    "tasks_reconciliation, never from plan or calendar words. Never comment on the user's ",
    "accounts, settings, setup or data quality, and never guess how the email or calendar ",
    "systems see the user; report only today's work. Close with exactly two short ",
    "reflection questions specific to today's items, never about setup or settings."
);

/// The one trusted block. It has no interpolation, which the isolation test checks.
pub fn trusted_instructions() -> String {
    format!("<trusted_instructions>\n{INSTRUCTIONS}\n\n{TRUST_BOUNDARY}\n</trusted_instructions>")
}

/// One user turn. The trusted block comes first, then one outside block per section.
pub fn build_prompt(sections: &[Section]) -> String {
    let mut parts = vec![trusted_instructions()];
    parts.extend(sections.iter().map(|s| render_external_block(s.key, &s.lines)));
    parts.join("\n\n")
}
