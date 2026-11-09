use super::parity_canon::Canon;
use moss_people::matching::candidate_signature;
use serde_json::{json, Value};

pub fn files(root: &std::path::Path) -> std::collections::BTreeSet<String> {
    fn visit(
        root: &std::path::Path,
        directory: &std::path::Path,
        out: &mut std::collections::BTreeSet<String>,
    ) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &path, out);
            } else {
                out.insert(path.strip_prefix(root).unwrap().to_str().unwrap().into());
            }
        }
    }
    let mut out = Default::default();
    visit(root, root, &mut out);
    out
}

// A missing-note candidate hashes a person UUID generated independently by each
// implementation. Recognize only the correct hash for a person in that run,
// then compare its canonical ID. Wrong hashes and other signatures stay literal.
pub fn signatures(value: &Value, people: &[Value], canon: &mut Canon) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| signatures(v, people, canon)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    let normalized =
                        if matches!(key.as_str(), "candidate_signature" | "candidateSignature") {
                            people
                                .iter()
                                .filter_map(|p| p["id"].as_str())
                                .find_map(|id| {
                                    (value.as_str()
                                        == Some(&candidate_signature(
                                            "create_person",
                                            &[id.into()],
                                        )))
                                    .then(|| {
                                        json!(format!(
                                            "<person-signature:{}>",
                                            canon.value(&json!(id)).as_str().unwrap()
                                        ))
                                    })
                                })
                                .unwrap_or_else(|| value.clone())
                        } else {
                            signatures(value, people, canon)
                        };
                    (key.clone(), normalized)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

// Normalize only the generated frontmatter UUID, retaining every other byte.
pub fn note_bytes(text: &str, canon: &mut Canon) -> String {
    let Some((id, rest)) = text
        .strip_prefix("---\njarvisPersonId: ")
        .and_then(|s| s.split_once('\n'))
    else {
        return text.to_owned();
    };
    if !super::parity_canon::is_uuid(id) || !rest.contains("\n---\n") {
        return text.to_owned();
    }
    format!(
        "---\njarvisPersonId: {}\n{rest}",
        canon.value(&json!(id)).as_str().unwrap()
    )
}

#[test]
fn comparison_retains_wrong_hashes_user_text_and_line_endings() {
    let mut canon = Canon::new(chrono::Utc::now(), &Default::default());
    let id = "10000000-0000-4000-8000-000000000001";
    let body = format!("Human text\njarvisPersonId: {id}\r\n");
    let text = format!("---\njarvisPersonId: {id}\ndisplayName: Created\n---\n{body}");
    assert_eq!(
        note_bytes(&text, &mut canon),
        format!("---\njarvisPersonId: <id:1>\ndisplayName: Created\n---\n{body}")
    );
    assert_eq!(note_bytes(&body, &mut canon), body);
    let crlf = text.replace('\n', "\r\n");
    assert_eq!(note_bytes(&crlf, &mut canon), crlf);
    let mut seeded = Canon::new(chrono::Utc::now(), &[id.to_owned()].into());
    assert_eq!(note_bytes(&text, &mut seeded), text);
    let hash = candidate_signature("create_person", &[id.into()]);
    let value = json!({"candidate_signature":hash,"candidateSignature":"wrong","body":hash});
    assert_eq!(
        signatures(&value, &[json!({"id":id})], &mut canon),
        json!({
            "candidate_signature":"<person-signature:<id:1>>", "candidateSignature":"wrong", "body":hash
        })
    );
}
