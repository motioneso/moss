use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub display_name: String,
    pub status: String,
    pub relationship_summary: Option<String>,
    pub context_summary: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub candidate_kind: String,
    pub suggested_display_name: Option<String>,
    pub reason_summary: Option<String>,
    #[serde(deserialize_with = "confidence")]
    pub confidence: f64,
    pub status: String,
}
impl Candidate {
    pub fn destructive(&self) -> bool {
        matches!(
            self.candidate_kind.as_str(),
            "merge_people" | "split_identity"
        )
    }
    pub fn label(&self) -> &'static str {
        match self.candidate_kind.as_str() {
            "create_person" => "New person",
            "link_identity" => "Link identity",
            "merge_people" => "Merge people",
            "split_identity" => "Split identity",
            _ => "Match",
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Directory {
    pub name: String,
    pub path: String,
}
#[derive(Clone, Default)]
pub struct ReadState<T> {
    pub value: Option<T>,
    pub error: bool,
    pub loading: bool,
}
impl<T> ReadState<T> {
    pub fn loading() -> Self {
        Self {
            value: None,
            error: false,
            loading: true,
        }
    }
    pub fn result(value: Result<T, ()>) -> Self {
        Self {
            error: value.is_err(),
            value: value.ok(),
            loading: false,
        }
    }
}

fn confidence<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| serde::de::Error::custom("Invalid confidence"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_numeric_strings_keep_match_confidence_and_destructive_review() {
        let c: Candidate = serde_json::from_value(serde_json::json!({"id":"id","candidateKind":"merge_people","suggestedDisplayName":null,"reasonSummary":null,"confidence":"0.75","status":"pending"})).unwrap();
        assert_eq!(c.confidence, 0.75);
        assert!(c.destructive());
    }
}
