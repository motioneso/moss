//! People & Context. Pure domain logic; all persistence belongs to the module SDK ports.
pub mod matching;
pub mod notes_format;

/// ECMAScript WhiteSpace + LineTerminator, as used by the existing note format and matching.
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
