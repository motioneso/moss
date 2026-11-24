//! The account-safe catalog surface. Configuration authority is an optional, separate projection.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub modules: Vec<ModuleView>,
    pub sources: Vec<SourceView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub management: Option<Vec<ModuleControl>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SourceView {
    pub id: String,
    pub name: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleView {
    pub id: String,
    pub source: String,
    pub source_name: String,
    pub name: String,
    pub description: String,
    pub publisher: String,
    pub first_party: bool,
    pub category: String,
    pub version: String,
    pub installed_version: Option<String>,
    pub enabled: Option<bool>,
    pub supports_user_disable: bool,
    pub status: String,
    pub update_available: bool,
    pub pinned: bool,
    pub changelog: String,
    pub permissions: Vec<String>,
    pub screenshots: Vec<Preview>,
    pub activity: Vec<RecentActivity>,
    pub settings_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Preview {
    pub url: String,
    pub caption: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecentActivity {
    pub at: String,
    pub label: String,
    pub source: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleControl {
    pub id: String,
    pub source: String,
    pub on_for_everyone: bool,
    pub pin: Option<String>,
}
