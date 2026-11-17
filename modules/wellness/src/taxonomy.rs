//! The feeling wheel. Each core feeling has a fixed list of second-level feelings.

pub const CORES: [&str; 6] = ["happy", "sad", "fear", "anger", "disgust", "surprise"];

fn feelings(core: &str) -> Option<&'static [&'static str]> {
    Some(match core {
        "happy" => &["Joy", "Curious", "Proud", "Satisfied", "Courageous", "Peaceful", "Intimate", "Optimistic"],
        "sad" => &["Guilt", "Abandoned", "Despair", "Depressed", "Lonely", "Apathetic"],
        "fear" => &["Scared", "Anxious", "Insecure", "Inferior", "Unwanted", "Embarrassed"],
        "anger" => &["Hurt", "Insecure", "Hateful", "Mad", "Aggressive", "Irritated", "Distant", "Critical"],
        "disgust" => &["Disapproval", "Disappointed", "Awful", "Aversion"],
        "surprise" => &["Shock", "Confusion", "Awe", "Excitement"],
        _ => return None,
    })
}

/// A bare core, or a core with one of its own second-level feelings. A third level is refused.
pub fn valid_path(core: &str, secondary: Option<&str>, tertiary: Option<&str>) -> bool {
    if tertiary.is_some() {
        return false;
    }
    let Some(list) = feelings(core) else { return false };
    secondary.map_or(true, |label| list.contains(&label))
}
