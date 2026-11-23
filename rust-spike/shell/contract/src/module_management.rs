//! Host-owned module management records. No source addresses, credentials or client-supplied actors.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleCapability {
    pub port: String,
    pub operations: Vec<String>,
    pub resources: Vec<String>,
    pub allow_private: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModulePermission {
    pub group: String,
    pub headline: String,
    pub details: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleReview {
    pub source: String,
    pub module: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub digest: String,
    pub previous: Option<String>,
    pub capabilities: Vec<ModuleCapability>,
    pub migrations: Vec<String>,
    pub permissions: Vec<ModulePermission>,
    pub urgent: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModuleOperationStage {
    Reviewed,
    Queued,
    Checking,
    Installing,
    Succeeded,
    Failed,
}
impl ModuleOperationStage {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModuleOperationResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModuleOperation {
    pub id: String,
    pub review: ModuleReview,
    pub stage: ModuleOperationStage,
    pub result: Option<ModuleOperationResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewModule {
    pub module: String,
    pub source: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecuteModule {
    pub approve: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModuleSource {
    pub id: String,
    pub name: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModule {
    pub id: String,
    pub source: String,
    pub version: String,
    pub digest: String,
    pub publisher: String,
    pub changelog: String,
    pub installed: bool,
    pub installed_digest: Option<String>,
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(default)]
    pub skipped_digest: Option<String>,
    #[serde(default)]
    pub urgent: bool,
    pub capabilities: Vec<ModuleCapability>,
    pub migrations: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModuleCatalog {
    pub sources: Vec<ModuleSource>,
    pub modules: Vec<CatalogModule>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateModule {
    pub operation: String,
    pub approve: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkipModuleUpdate {
    pub source: String,
    pub digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinModule {
    pub source: String,
    pub version: Option<String>,
}
