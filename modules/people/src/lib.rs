//! People & Context. Pure domain logic; all persistence belongs to the module SDK ports.
pub mod guest;
pub mod matching;
mod name_lookup;
pub mod note_edits;
pub mod notes_format;
pub mod notes_service;
pub mod repository;
pub mod repository_mutations;
mod review;
mod routes;

#[cfg(all(feature = "component", target_arch = "wasm32"))]
moss_module_sdk::export_module!(
    crate::guest::handle,
    [
        moss_module_sdk::component::ports::DB,
        moss_module_sdk::component::ports::CONTEXT,
        moss_module_sdk::component::ports::VAULT,
    ]
);

/// ECMAScript WhiteSpace + LineTerminator, as used by the existing note format and matching.
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
