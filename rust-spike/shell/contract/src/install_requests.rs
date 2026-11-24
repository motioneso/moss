//! Configuration metadata only. The authenticated session supplies the requester.
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestInstall {
    pub source: String,
    pub module: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveInstallRequest {
    pub operation: String,
    pub approve: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub id: String,
    pub owner_account_id: String,
    pub source: String,
    pub module: String,
    pub created_at: String,
    pub operation_id: Option<String>,
    pub status: String,
    pub notice: &'static str,
    pub notice_reason: &'static str,
}
