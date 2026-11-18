//! Tool names retain the existing module contracts, including camelCase operation names.
//! Module IDs and archive/file paths continue to use their separate, stricter validators.
pub(crate) fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.split('.').all(|part| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_lowercase()
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::valid;

    #[test]
    fn exact_existing_people_names_are_valid() {
        for name in [
            "people.resolve",
            "people.getContext",
            "people.listRecent",
            "people.acceptMatch",
            "people.rejectMatch",
            "people.merge",
            "people.splitIdentity",
        ] {
            assert!(valid(name), "Legacy tool name was refused: {name}");
        }
    }

    #[test]
    fn unsafe_or_unbounded_names_are_refused() {
        for name in [
            "",
            ".",
            "people.",
            ".people",
            "people..merge",
            "people/merge",
            "people\\merge",
            "people.工具",
            "People.merge",
            "people.1merge",
            "people.merge\0",
        ] {
            assert!(!valid(name), "Unsafe tool name was accepted: {name:?}");
        }
        assert!(!valid(&"x".repeat(101)));
        assert!(valid("tasks.mark-done"));
    }
}
