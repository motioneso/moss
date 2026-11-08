//! Pure Notes operations. No filesystem, database, runtime or other module internals.
pub mod blocks;
pub mod identity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Preliminary literal edit helper. Legacy JavaScript dollar replacement tokens are deferred;
/// this helper must not stand in for complete chat-tool parity.
pub fn edit(content: &str, old: &str, new: &str) -> Result<String> {
    if old.is_empty() {
        return Err(Error("oldText must be non-empty".into()));
    }
    let count = content.matches(old).count();
    if count != 1 {
        return Err(Error(format!("oldText appears {count} times")));
    }
    Ok(content.replacen(old, new, 1))
}
