use moss_people::settings::compare_directory_names;

fn sorted(names: &[&str]) -> Vec<String> {
    let mut names: Vec<String> = names.iter().map(ToString::to_string).collect();
    names.sort_by(|a, b| compare_directory_names(a, b));
    names
}

#[test]
fn directory_names_follow_the_legacy_locale_order() {
    // Recorded from the legacy JavaScript `localeCompare` sort.
    assert_eq!(
        sorted(&[
            "Banana",
            "apple",
            "Ära",
            "Cherry",
            "zebra",
            "Ångström",
            "banana"
        ]),
        [
            "Ångström",
            "apple",
            "Ära",
            "banana",
            "Banana",
            "Cherry",
            "zebra"
        ]
    );
}

#[test]
fn directory_names_keep_plain_and_numeric_order() {
    assert_eq!(
        sorted(&["Work", "Family", "10", "2", "family"]),
        ["10", "2", "family", "Family", "Work"]
    );
}
