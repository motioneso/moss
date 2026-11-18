use moss_people::notes_format::{
    replace_moss_managed_section, PEOPLE_MANAGED_END, PEOPLE_MANAGED_START,
};

#[test]
fn managed_text_preserves_dollar_tokens_and_human_text_literally() {
    // Deliberate safety correction to legacy String.replace: user text must not
    // expand $&, $$, $`, or $' into old content or duplicate human notes.
    let managed = "Prices $$5; matched $&; before $`; after $'; capture $1 $<name>";
    let body =
        format!("Human prefix\n{PEOPLE_MANAGED_START}\nold\n{PEOPLE_MANAGED_END}\nHuman suffix");
    let expected = format!(
        "Human prefix\n{PEOPLE_MANAGED_START}\n{managed}\n{PEOPLE_MANAGED_END}\nHuman suffix"
    );
    assert_eq!(replace_moss_managed_section(&body, managed), expected);
    assert_eq!(replace_moss_managed_section(&expected, managed), expected);
    assert_eq!(
        replace_moss_managed_section("Human text", managed),
        format!("Human text\n\n{PEOPLE_MANAGED_START}\n{managed}\n{PEOPLE_MANAGED_END}\n")
    );
}
