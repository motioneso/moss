use moss_people::{
    note_edits::{
        create_note, destination_names, find_canonical_note, refresh_plan, select_destination,
        update_note, CreateNote, EditError, ExistingPerson, NoteFile, UpdateNote,
    },
    notes_format::{parse_people_note, NoteStatus},
};

fn input() -> CreateNote {
    CreateNote {
        display_name: "Alice Example".into(),
        aliases: vec!["Al".into()],
        emails: vec!["ALICE@example.test".into()],
        phones: vec!["+1 555 0100".into()],
    }
}

#[test]
fn creates_canonical_frontmatter_and_managed_summary() {
    let content = create_note("person-id", &input());
    assert_eq!(content, "---\njarvisPersonId: person-id\ndisplayName: Alice Example\naliases:\n  - Al\nemails:\n  - ALICE@example.test\nphones:\n  - +1 555 0100\nstatus: active\n---\n# Alice Example\n\n<!-- jarvis:people:start -->\nDisplay name: Alice Example\nEmails: ALICE@example.test\nPhones: +1 555 0100\n<!-- jarvis:people:end -->\n");
}

#[test]
fn an_existing_empty_file_is_not_an_unused_destination() {
    let names = destination_names(" Alice / Example! ", "12345678-abcd");
    assert_eq!(names, ["Alice-Example.md", "Alice-Example-12345678.md"]);
    assert_eq!(
        select_destination(&names, &[None, None]),
        Ok("Alice-Example.md")
    );
    assert_eq!(
        select_destination(&names, &[Some(String::new()), None]),
        Ok("Alice-Example-12345678.md")
    );
    assert_eq!(
        select_destination(&names, &[Some(String::new()), Some("existing".into())]),
        Err(EditError::DestinationExists)
    );
    assert_eq!(
        destination_names("名字", "abcdefgh-ijkl"),
        ["Person.md", "Person-abcdefgh.md"]
    );
}

#[test]
fn updates_use_fresh_content_and_preserve_human_text() {
    let created = create_note("person-id", &input());
    let current = created.replace(
        "# Alice Example",
        "# Alice Example\n\nHuman update made after the earlier read",
    );
    let patch = UpdateNote {
        display_name: Some("Alice Renamed".into()),
        phones: Some(vec![]),
        status: Some(NoteStatus::Archived),
        ..Default::default()
    };
    let updated = update_note(Some(&current), "person-id", &patch).unwrap();
    let parsed = parse_people_note(&updated).unwrap();
    assert_eq!(
        parsed.frontmatter.jarvis_person_id.as_deref(),
        Some("person-id")
    );
    assert_eq!(parsed.frontmatter.display_name, "Alice Renamed");
    assert_eq!(parsed.frontmatter.status, NoteStatus::Archived);
    assert_eq!(parsed.frontmatter.emails, input().emails);
    assert!(parsed
        .body
        .contains("Human update made after the earlier read"));
    assert!(parsed.body.contains("Display name: Alice Renamed"));
    assert!(!parsed.body.contains("Phones:"));
    // The current service does not rewrite the human heading when renaming.
    assert!(parsed.body.starts_with("# Alice Example\n"));
}

#[test]
fn stale_canonical_ids_and_deleted_notes_are_refused() {
    let content = create_note("changed-id", &input());
    for current in [Some(content.as_str()), Some("not a people note"), None] {
        assert_eq!(
            update_note(current, "original-id", &UpdateNote::default()),
            Err(EditError::CanonicalNoteNotFound)
        );
    }
}

#[test]
fn refresh_projects_unique_notes_and_reviews_ambiguous_or_missing_ones() {
    let files = vec![
        NoteFile {
            path: "unique.md".into(),
            content: create_note("unique", &input()),
        },
        NoteFile {
            path: "duplicate-a.md".into(),
            content: create_note("duplicate", &input()),
        },
        NoteFile {
            path: "duplicate-b.md".into(),
            content: create_note("duplicate", &input()),
        },
        NoteFile {
            path: "missing-id.md".into(),
            content: "---\ndisplayName: Unknown\nstatus: active\n---\nBody\n".into(),
        },
        NoteFile {
            path: "ordinary.md".into(),
            content: "# A regular note".into(),
        },
        NoteFile {
            path: "ignored.MD".into(),
            content: create_note("uppercase-extension", &input()),
        },
        NoteFile {
            path: "asset.txt".into(),
            content: String::new(),
        },
    ];
    let people = vec![
        ExistingPerson {
            id: "unique".into(),
            merged: false,
        },
        ExistingPerson {
            id: "duplicate".into(),
            merged: false,
        },
        ExistingPerson {
            id: "missing".into(),
            merged: false,
        },
        ExistingPerson {
            id: "already-merged".into(),
            merged: true,
        },
    ];
    let plan = refresh_plan(&files, &people);
    assert_eq!(
        (
            plan.discovered,
            plan.ignored,
            plan.projections.len(),
            plan.reviews.len()
        ),
        (5, 1, 1, 3)
    );
    assert_eq!(plan.projections[0].path, "unique.md");
    assert_eq!(
        plan.reviews[0].reason_summary,
        "People note missing jarvisPersonId"
    );
    assert_eq!(plan.reviews[0].ids, ["missing-id.md"]);
    assert_eq!(
        plan.reviews[1].reason_summary,
        "Duplicate canonical People notes"
    );
    assert_eq!(
        plan.reviews[1].ids,
        ["duplicate", "duplicate-a.md", "duplicate-b.md"]
    );
    assert_eq!(
        plan.reviews[2].reason_summary,
        "Existing People record missing canonical note"
    );
    assert_eq!(plan.reviews[2].ids, ["missing"]);
    assert_eq!(
        find_canonical_note(&files, "unique").unwrap().path,
        "unique.md"
    );
    assert!(matches!(
        find_canonical_note(&files, "duplicate"),
        Err(EditError::CanonicalNoteNotFound)
    ));
    assert!(matches!(
        find_canonical_note(&files, "missing"),
        Err(EditError::CanonicalNoteNotFound)
    ));
}
