//! Fixed after-the-fact acceptance for plain writes, from the host-sanitized result.
use moss_shell_contract::{ChangedField, CompletedWrite};
use serde_json::Value;

pub fn from_reply(id: &str, reply: &str) -> Option<CompletedWrite> {
    let value: Value = serde_json::from_str(reply).ok()?;
    let fields = value
        .get("data")
        .and_then(|data| data.get("changed"))
        .or_else(|| value.get("changed"))?
        .as_array()?;
    if fields.is_empty() || fields.len() > 32 {
        return None;
    }
    let text = |v: &Value| -> Option<String> {
        let s = v.as_str()?;
        (s.len() <= 8192).then(|| s.to_owned())
    };
    let changed = fields
        .iter()
        .map(|f| {
            Some(ChangedField {
                label: text(&f["label"])?,
                before: text(&f["before"])?,
                after: text(&f["after"])?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    if changed.iter().any(|f| f.label.trim().is_empty()) {
        return None;
    }
    Some(CompletedWrite {
        id: id.into(),
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn done_uses_only_complete_labelled_changes() {
        let done = from_reply(
            "t:1",
            r#"{"changed":[{"label":"Note","before":"Old","after":"New"}]}"#,
        )
        .unwrap();
        assert_eq!(done.changed[0].after, "New");
        assert_eq!(
            from_reply(
                "t:2",
                r#"{"data":{"changed":[{"label":"Note","before":"Old","after":"New"}]}}"#
            )
            .unwrap()
            .changed,
            done.changed
        );
        assert!(from_reply("t:3", r#"{"changed":[{"label":"Note","after":"New"}]}"#).is_none());
    }
}
