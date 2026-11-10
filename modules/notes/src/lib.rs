//! Notes guest. Domain operations are pure; host access uses only the module SDK.
pub mod blocks;
#[cfg(feature = "write-tools")]
pub mod daily_archive;
pub mod export;
pub mod guest;
pub mod identity;
#[cfg(feature = "write-tools")]
pub mod private_export;
pub mod routes;
pub mod search;
mod settings_input;
#[cfg(feature = "write-tools")]
pub mod sync;
#[cfg(feature = "write-tools")]
mod sync_recovery;
#[cfg(feature = "write-tools")]
pub mod sync_worker;
pub mod write_tools;

#[cfg(target_arch = "wasm32")]
mod component;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Legacy string-search replacement, including JavaScript's GetSubstitution tokens.
/// A string search has no capture groups: numbered and named tokens remain literal.
pub fn edit(content: &str, old: &str, new: &str) -> Result<String> {
    if old.is_empty() {
        return Err(Error("oldText must be non-empty".into()));
    }
    let count = content.matches(old).count();
    if count != 1 {
        return Err(Error(format!("oldText appears {count} times")));
    }
    let at = content.find(old).expect("one occurrence");
    let prefix = &content[..at];
    let suffix = &content[at + old.len()..];
    let mut replacement = String::new();
    let mut chars = new.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            let value = match chars.peek() {
                Some('$') => Some("$"),
                Some('&') => Some(old),
                Some('`') => Some(prefix),
                Some('\'') => Some(suffix),
                _ => None,
            };
            if let Some(value) = value {
                chars.next();
                replacement.push_str(value);
                continue;
            }
        }
        replacement.push(c);
    }
    Ok(format!("{prefix}{replacement}{suffix}"))
}
