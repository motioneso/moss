//! Lucide icons as inline SVG, the same glyphs the TypeScript screen draws.

fn svg(size: u32, paths: &str) -> String {
    format!(
        r#"<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{paths}</svg>"#
    )
}

pub fn plus(size: u32) -> String {
    svg(size, r#"<path d="M5 12h14"/><path d="M12 5v14"/>"#)
}

pub fn check(size: u32) -> String {
    svg(size, r#"<path d="M20 6 9 17l-5-5"/>"#)
}

pub fn calendar(size: u32) -> String {
    svg(size, r#"<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>"#)
}

pub fn alert(size: u32) -> String {
    svg(size, r#"<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>"#)
}

pub fn panel_right(size: u32) -> String {
    svg(size, r#"<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>"#)
}

pub fn sliders(size: u32) -> String {
    svg(size, r#"<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>"#)
}

/// Empty circle is quick, left half is medium, full is large.
pub fn effort(effort: &str) -> String {
    let fill = match effort {
        "large" => r#"<circle cx="7" cy="7" r="5.5" fill="currentColor" stroke="none"/>"#,
        "medium" => r#"<path d="M7 1.5 A5.5 5.5 0 0 0 7 12.5 Z" fill="currentColor"/>"#,
        _ => "",
    };
    format!(
        r#"<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>{fill}</svg>"#
    )
}
