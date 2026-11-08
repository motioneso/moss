//! People & Context. Pure domain logic; all persistence belongs to the module SDK ports.
pub mod guest;
pub mod jobs;
pub mod matching;
mod name_lookup;
pub mod note_edits;
mod note_values;
pub mod notes_format;
pub mod notes_service;
pub mod repository;
pub mod repository_mutations;
mod review;
mod route_validation;
mod routes;
mod tools;

#[cfg(all(feature = "generated-component", feature = "component"))]
compile_error!("Select either the generated or handwritten component binding");
#[cfg(all(feature = "generated-component", target_arch = "wasm32"))]
mod generated_component;

#[cfg(all(feature = "component", target_arch = "wasm32"))]
moss_module_sdk::export_module!(
    crate::guest::handle,
    [
        moss_module_sdk::component::ports::DB,
        moss_module_sdk::component::ports::CONTEXT,
        moss_module_sdk::component::ports::VAULT,
        moss_module_sdk::component::ports::KV,
        moss_module_sdk::component::ports::JOBS,
        moss_module_sdk::component::ports::API,
    ]
);

/// ECMAScript WhiteSpace + LineTerminator, as used by the existing note format and matching.
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub mod settings;
