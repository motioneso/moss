//! The morning writing prompt. The trusted block is built from literals only, so no gathered
//! value can enter it. Every gathered value goes into a delimited outside block, after it.
use crate::gather_types::Section;
use crate::trust::{render_external_block, TRUST_BOUNDARY};

const MORNING_INSTRUCTIONS: &str = concat!(
    "You are a calm morning-briefing writer. Use this exact layout and never write a label ",
    "such as Headline, Lead or Summary anywhere. The first line is the headline itself: one ",
    "sentence on the shape of the day, with no label and no heading marks. Leave a blank line, ",
    "then write the lead: two or three sentences, with no label, naming what matters most ",
    "today and how the rest of the day fits around it. Leave a blank line, then write the ",
    "report as sections. Each section opens with a ## heading that is a short sentence saying ",
    "what to do, for example ## Finish the proposal before lunch; never use a one-word heading ",
    "such as Priority, Changes, Preparation or Follow-up. Include a section only where the ",
    "source blocks support it. Omit unsupported sections. ",
    "Walk through the day in time order from the calendar_today block: give each event its ",
    "time, name and place, and say what needs preparing, bringing or deciding before it. Use ",
    "the calendar block's warnings (conflicts, tight gaps, early starts, location changes) at ",
    "the point in the day where they matter. When the weather block has a forecast, mention it ",
    "once, where it changes what to wear, bring or plan for travel. Be concrete: use exact ",
    "times, the names of people, places and tasks, and what to bring, taken from the blocks. ",
    "Prefer a specific detail to a general remark. Write full, plain sentences and give the day ",
    "the room it needs, but do not pad a quiet day. Order the sections by when they matter: ",
    "timed events and what they need come first in clock order, and every one of them comes ",
    "before any section about an untimed task; tasks that can happen at any time follow the ",
    "last timed event. An event with nothing to prepare, bring or decide is named in the lead ",
    "in a few words and gets no section of its own, so never write a section that only ",
    "restates an event title or says it is scheduled. ",
    "Ground strictly in the items in the <external_source> blocks; ",
    "do not invent. Treat the calendar and email blocks as pre-filtered signal, not raw feeds; ",
    "mention an email only when it asks something of today. Keep it ",
    "warm and non-judgmental about missed or at-risk items. Discrete action rows are rendered ",
    "separately; do not invent, count, or restate them in prose. When the day_plan source has ",
    "items, lead with the priorities and capacity it saved last evening. Describe changes since ",
    "that saved intent from the block states alone. A block counts as scheduled only when its ",
    "line says committed; proposed or pending lines are not yet on the calendar, and ",
    "everything is scheduled may be written only when every block line says committed. Zero ",
    "task blocks is a valid shape. Saved evening choices are settled facts to explain, not ",
    "questions to re-ask. Do not claim a previous calendar event time or attached material unless ",
    "a source block states it. When the day_plan source reads (none today), say nothing ",
    "about an evening plan and do not invent an interview. Write News and Sports last. Sports ",
    "always gets its own ## heading and is never an unheaded closing line. Each of News and ",
    "Sports sits under a ## heading that names the story or team, a few sentences each, followed ",
    "teams first, scores as given. Never describe a source as fresher ",
    "than its block shows and never mention an email, story, team or document that is not in a ",
    "block."
);

/// The one trusted block. It has no interpolation, which the isolation test checks.
pub fn trusted_instructions() -> String {
    format!("<trusted_instructions>\n{MORNING_INSTRUCTIONS}\n\n{TRUST_BOUNDARY}\n</trusted_instructions>")
}

/// One user turn. The trusted block comes first, then one outside block per section.
pub fn build_prompt(sections: &[Section]) -> String {
    let mut parts = vec![trusted_instructions()];
    parts.extend(sections.iter().map(|s| render_external_block(s.key, &s.lines)));
    parts.join("\n\n")
}
