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
    #[serde(default)]
    pub source_name: String,
    #[serde(default)]
    pub publisher: String,
    pub module: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub digest: String,
    pub previous: Option<String>,
    #[serde(default)]
    pub previous_version: Option<String>,
    #[serde(default)]
    pub changelog: String,
    #[serde(default)]
    pub new_migrations: Vec<String>,
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
    Downloading,
    Verifying,
    SettingUpData,
    Activating,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_version: Option<String>,
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModuleOperation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<ModuleReview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<ModuleLifecycle>,
    pub stage: ModuleOperationStage,
    #[serde(default)]
    pub stages: Vec<ModuleOperationStage>,
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

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleAction {
    Remove,
    DeleteData,
    Restore,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModuleLifecycle {
    pub module: String,
    pub action: LifecycleAction,
    pub snapshot: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveModule {
    pub module: String,
    #[serde(default)]
    pub delete_data: bool,
    #[serde(default)]
    pub typed_name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreModule {
    pub module: String,
    pub snapshot: String,
    pub typed_name: String,
    pub acknowledge_data_loss: bool,
}
/// Metadata only: never serialize the private snapshot's previous activation or contents.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModuleSnapshot {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub name: String,
    pub module: String,
    pub id: String,
    pub created: String,
    pub expires: String,
    pub reason: String,
}
