//! Strict app-map data. Matches the module SDK's declarations; no field executes code.
use anyhow::{ensure, Result};
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Navigation {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub path: String,
    pub icon: Option<String>,
    pub order: Option<f64>,
    pub permission_id: Option<String>,
    pub feature_flag_id: Option<String>,
    pub badge: Option<Badge>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Badge {
    pub source: BadgeSource,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BadgeSource {
    Notifications,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Setting {
    pub id: String,
    pub label: String,
    pub description: String,
    pub path: String,
    pub scope: Scope,
    pub order: Option<f64>,
    pub permission_id: Option<String>,
    pub feature_flag_id: Option<String>,
    pub entry: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    User,
    Admin,
    System,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Feature {
    pub id: String,
    pub description: String,
    pub requires: Option<Requirement>,
    #[serde(default)]
    pub remediations: Vec<Remediation>,
    #[serde(default)]
    pub errors: Vec<Error>,
    pub feature_flag_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub service: String,
    pub capability: moss_platform_routing::Capability,
    pub tier: moss_platform_routing::Tier,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remediation {
    pub id: String,
    pub description: String,
    pub path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Error {
    pub code: String,
    pub class: ErrorClass,
    pub description: String,
    pub remediation_ref: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorClass {
    Prerequisite,
    Transient,
    Validation,
    Permission,
    Bug,
}
fn route(path: &str) -> Result<()> {
    ensure!(
        path.starts_with('/')
            && !path.starts_with("//")
            && !path.contains(['\\', '\0'])
            && !path.split('/').any(|p| matches!(p, "." | "..")),
        "Invalid app-map path"
    );
    Ok(())
}
pub fn validate(m: &crate::manifest::Manifest) -> Result<()> {
    for value in &m.navigation {
        let n: Navigation = serde_json::from_value(value.clone())?;
        route(&n.path)?;
    }
    for value in &m.settings {
        let s: Setting = serde_json::from_value(value.clone())?;
        route(&s.path)?;
    }
    for value in &m.features {
        let f: Feature = serde_json::from_value(value.clone())?;
        if let Some(r) = f.requires {
            ensure!(
                r.service.starts_with("module."),
                "AI service must be module-owned"
            );
        }
        for r in &f.remediations {
            route(&r.path)?;
        }
        for error in f.errors {
            if let Some(reference) = error.remediation_ref {
                ensure!(
                    f.remediations.iter().any(|r| r.id == reference),
                    "App-map remediation is missing"
                );
            }
        }
    }
    Ok(())
}
