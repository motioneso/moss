//! Publisher review evidence carried inside the signed index. This is registry review,
//! separate from each installation's consent to a package's permissions.
use crate::manifest::Capability;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishDiff {
    pub new_publisher: bool,
    pub capabilities: Vec<Capability>,
    pub fetch_hosts: BTreeSet<String>,
}
impl PublishDiff {
    pub fn requires_review(&self) -> bool {
        self.new_publisher || !self.capabilities.is_empty() || !self.fetch_hosts.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRequest {
    pub registry_id: String,
    pub base_index_digest: String,
    pub digest: String,
    pub previous_digest: Option<String>,
    pub publisher_key: String,
    pub publisher_public_key: String,
    pub diff: PublishDiff,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanApproval {
    pub request: ReviewRequest,
    pub reviewer: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishReview {
    pub request: ReviewRequest,
    pub approval: Option<HumanApproval>,
}
