//! Account-safe installed trust and local review projections, never signing secrets.
use serde::{Deserialize, Serialize};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleTrust {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub source_name: String,
    pub digest: String,
    pub local: bool,
    pub can_manage: bool,
    pub fingerprint: Option<String>,
    pub notices: Vec<TrustNotice>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct TrustNotice {
    pub source: String,
    pub reason: String,
    pub level: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReview {
    pub id: String,
    pub name: String,
    pub version: String,
    pub digest: String,
    pub fingerprint: String,
    pub permissions: Vec<String>,
    pub signature: serde_json::Value,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct RegistryView {
    pub id: String,
    pub name: String,
    pub fingerprint: String,
    pub confirmed: bool,
    #[serde(default)]
    pub health: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Registries {
    pub registries: Vec<RegistryView>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageReview {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub digest: String,
    pub fingerprint: String,
    pub permissions: Vec<String>,
    pub installed: bool,
}
