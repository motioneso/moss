use super::*;
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Default)]
struct Scan {
    listings: Value,
    reads: RefCell<Vec<String>>,
    contents: BTreeMap<String, Option<String>>,
    fail_on: Option<(&'static str, String)>,
}
impl Host for Scan {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        assert_eq!((port, resource), ("vault", RESOURCE));
        let path = parameters["path"].as_str().unwrap();
        if self
            .fail_on
            .as_ref()
            .is_some_and(|(op, p)| (*op, p.as_str()) == (operation, path))
        {
            return Err(Error::new("Synthetic backend failure"));
        }
        match operation {
            "notes.list" => Ok(json!({"entries": self.listings[path]})),
            "notes.read" => {
                self.reads.borrow_mut().push(path.into());
                let content = self
                    .contents
                    .get(path)
                    .cloned()
                    .unwrap_or_else(|| Some(format!("# {path}\n")));
                Ok(json!({"path":path,"destinationId":"fixture","content":content}))
            }
            _ => panic!("Unexpected scan operation: {operation}"),
        }
    }
}

#[test]
fn nested_note_scan_matches_the_legacy_vault_walk() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/note-scan-parity.json")).unwrap();
    for case in cases {
        let scan = Scan {
            listings: case["listings"].clone(),
            ..Scan::default()
        };
        let files = NotesService::new(&scan).files().unwrap();
        let paths: Vec<_> = files.iter().map(|file| &file.path).collect();
        assert_eq!(json!(paths), case["expected"], "Legacy traversal: {case}");
        assert_eq!(json!(*scan.reads.borrow()), case["expected"]);
        for file in files {
            assert_eq!(file.content, format!("# {}\n", file.path));
        }
    }
}

#[test]
fn nested_scan_keeps_the_total_entry_and_text_limits() {
    let entries: Vec<_> = (0..1999)
        .map(|i| json!({"name":format!("{i}.md"),"kind":"file"}))
        .collect();
    let mut scan = Scan {
        listings: json!({"": [{"name":"A","kind":"directory"}], "A": entries}),
        ..Scan::default()
    };
    assert_eq!(NotesService::new(&scan).files().unwrap().len(), 1999);
    scan.listings["A"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"overflow.md","kind":"file"}));
    // refresh must stop before any repository access; this host rejects all DB calls.
    assert_eq!(
        NotesService::new(&scan).refresh().unwrap_err().message,
        "People folder exceeds the note scan limit"
    );

    let entries: Vec<_> = (0..16)
        .map(|i| json!({"name":format!("{i}.md"),"kind":"file"}))
        .collect();
    let mut scan = Scan {
        listings: json!({"": entries}),
        contents: (0..16)
            .map(|i| (format!("{i}.md"), Some("x".repeat(256 * 1024))))
            .collect(),
        ..Scan::default()
    };
    assert_eq!(NotesService::new(&scan).files().unwrap().len(), 16);
    scan.listings[""]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"overflow.md","kind":"file"}));
    assert_eq!(
        NotesService::new(&scan).refresh().unwrap_err().message,
        "People folder exceeds the note scan size limit"
    );
}

#[test]
fn failed_nested_scans_never_start_projection() {
    let listings = json!({"": [{"name":"root.md","kind":"file"},{"name":"A","kind":"directory"}],
        "A": [{"name":"nested.md","kind":"file"}]});
    for fail_on in [("notes.list", "A"), ("notes.read", "A/nested.md")] {
        let scan = Scan {
            listings: listings.clone(),
            fail_on: Some((fail_on.0, fail_on.1.into())),
            ..Scan::default()
        };
        assert_eq!(
            NotesService::new(&scan).refresh().unwrap_err().message,
            "Synthetic backend failure"
        );
    }
    let scan = Scan {
        listings,
        contents: BTreeMap::from([("A/nested.md".into(), None)]),
        ..Scan::default()
    };
    assert_eq!(
        NotesService::new(&scan).refresh().unwrap_err().message,
        "People note changed during refresh"
    );
}
