//! The open-shortcut check. Behaves like the old web validator, so saved shortcuts stay valid.

const MODIFIERS: [&str; 6] = ["mod", "ctrl", "cmd", "meta", "alt", "shift"];

/// ctrl, cmd and meta all mean the same key as mod on their own platform.
fn canonical(modifier: &str) -> &str {
    match modifier {
        "ctrl" | "cmd" | "meta" => "mod",
        other => other,
    }
}

/// True when the text is one or more known modifiers plus a key, has a modifier other than
/// shift, and is not control-or-command plus K (the command palette).
pub fn is_valid(shortcut: &str) -> bool {
    let parts: Vec<String> = shortcut
        .trim_matches(super::routes::is_js_space)
        .split('+')
        .map(|part| part.trim_matches(super::routes::is_js_space).to_lowercase())
        .filter(|part| !part.is_empty())
        .collect();
    let Some((key, modifiers)) = parts.split_last() else { return false };
    if modifiers.is_empty() || !modifiers.iter().all(|m| MODIFIERS.contains(&m.as_str())) {
        return false;
    }
    let canonicals: Vec<&str> = modifiers.iter().map(|m| canonical(m)).collect();
    if canonicals.iter().all(|m| *m == "shift") {
        return false;
    }
    !(key == "k" && canonicals.contains(&"mod"))
}
