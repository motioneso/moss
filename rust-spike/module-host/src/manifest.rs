use anyhow::{bail, ensure, Result};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const ABI: &str = "moss:module@1";
pub const PORTS: &[&str] = &[
    "db",
    "kv",
    "vault",
    "fetch",
    "credentials",
    "ai",
    "embed",
    "jobs",
    "events",
    "api",
    "notify",
    "attachments",
    "tools",
    "action-policy",
    "context",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub port: String,
    pub operations: BTreeSet<String>,
    #[serde(default)]
    pub resources: BTreeSet<String>,
    #[serde(default)]
    pub allow_private: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub publisher: String,
    pub version: Version,
    pub requires_moss: VersionReq,
    pub abi: String,
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub database: Database,
    #[serde(default)]
    pub jobs: BTreeMap<String, BTreeMap<String, ParameterKind>>,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub provides: BTreeMap<String, Version>,
    #[serde(default)]
    pub requires: BTreeMap<String, VersionReq>,
    #[serde(default)]
    pub navigation: Vec<Value>,
    #[serde(default)]
    pub settings: Vec<Value>,
    #[serde(default)]
    pub features: Vec<Value>,
    #[serde(default)]
    pub screens: BTreeMap<String, String>,
    pub icons: Vec<String>,
    pub accounts: Accounts,
    #[serde(default)]
    pub credentials: BTreeMap<String, Credential>,
    #[serde(default)]
    pub tools: BTreeMap<String, Tool>,
    #[serde(default)]
    pub install_wide_kv: BTreeSet<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Database {
    #[serde(default)]
    pub owned_tables: Vec<String>,
    #[serde(default)]
    pub migrations: Vec<String>,
    #[serde(default)]
    pub ledger: Ledger,
    #[serde(default)]
    pub access: BTreeMap<String, TableAccess>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "access", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TableAccess {
    OwnerOnly,
    OwnerOrShare {
        #[serde(rename = "resourceType")]
        resource_type: String,
        #[serde(rename = "shareKey")]
        share_key: String,
    },
}
pub fn table_prefix(id: &str) -> String {
    id.replace('-', "__").replace('.', "_") + "_"
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Ledger {
    #[default]
    Module,
    CoreLegacy,
    ModuleLegacy,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Route {
    pub method: String,
    pub path: String,
    pub sign_in: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Accounts {
    pub supports_user_disable: bool,
    pub default_enabled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credential {
    #[serde(default)]
    pub exchange: Option<Exchange>,
    pub scope: CredentialScope,
    pub hosts: BTreeSet<String>,
    pub attachment: Attachment,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Exchange {
    pub endpoint: String,
    pub grant_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tool {
    pub description: String,
    pub risk: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialScope {
    Account,
    Instance,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    content = "name",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum Attachment {
    Header(String),
    Basic,
    Body(String),
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    content = "choices",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum ParameterKind {
    Id,
    Flag,
    Count,
    Choice(BTreeSet<String>),
}

pub fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.split('.').all(|part| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_lowercase()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
pub fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 240
        && path.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.ends_with('.')
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
                && !matches!(
                    p.split('.').next().unwrap_or(""),
                    "con" | "prn" | "aux" | "nul" | "com1" | "lpt1"
                )
        })
}
impl Manifest {
    pub fn validate(&self, moss: &Version) -> Result<()> {
        crate::metadata::validate(self)?;
        ensure!(
            self.schema_version == 2,
            "This package uses an unsupported manifest version"
        );
        ensure!(
            identifier(&self.id),
            "The module name is not a safe identifier"
        );
        ensure!(
            self.abi == ABI,
            "This module needs an update from its publisher"
        );
        ensure!(
            self.requires_moss.matches(moss),
            "This module needs a different Moss version"
        );
        let mut ports = BTreeSet::new();
        for cap in &self.capabilities {
            ensure!(
                PORTS.contains(&cap.port.as_str()) && ports.insert(&cap.port),
                "Unknown or repeated permission"
            );
            ensure!(
                !cap.operations.is_empty(),
                "A permission must name its operations"
            );
            for op in &cap.operations {
                ensure!(identifier(op), "Invalid permission operation");
            }
            if matches!(cap.port.as_str(), "fetch" | "credentials") {
                for host in &cap.resources {
                    validate_host(host)?;
                }
            }
            ensure!(
                !cap.allow_private || matches!(cap.port.as_str(), "fetch" | "credentials"),
                "Private network permission belongs to network ports"
            );
        }
        ensure!(!self.icons.is_empty(), "The package needs an icon");
        for path in self
            .icons
            .iter()
            .chain(self.screens.values())
            .chain(&self.database.migrations)
        {
            ensure!(relative_path(path), "A package file name is unsafe");
        }
        ensure!(
            self.icons.iter().all(|p| p.starts_with("icons/")),
            "Icons must live in the icons folder"
        );
        ensure!(
            self.screens.values().all(|p| p.starts_with("ui/")),
            "Screens must live in the ui folder"
        );
        ensure!(
            self.database
                .migrations
                .iter()
                .all(|p| p.starts_with("sql/") && p.ends_with(".sql")),
            "Migrations must live in the sql folder"
        );
        ensure!(
            self.database.ledger != Ledger::CoreLegacy
                || (!self.id.contains('.')
                    && crate::legacy::has_ledger(&self.id, &Ledger::CoreLegacy)),
            "Only compiled first-party modules can use the historical core ledger"
        );
        let mut last = 0_u64;
        for path in &self.database.migrations {
            let number = crate::legacy::version(path)?.parse::<u64>()?;
            ensure!(
                number > last,
                "Migrations must be unique and in forward numeric order"
            );
            last = number;
        }
        let prefix = table_prefix(&self.id);
        for table in &self.database.owned_tables {
            ensure!(
                (table.starts_with(&format!("app.{prefix}"))
                    || (self.database.ledger != Ledger::Module
                        && crate::legacy::owns(&self.id, table)))
                    && table.len() <= 67
                    && table[4..]
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                "A module can own only its own tables"
            );
        }
        ensure!(
            self.database
                .owned_tables
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                == self.database.owned_tables.len(),
            "Repeated owned table"
        );
        for (table, access) in &self.database.access {
            ensure!(
                self.database.owned_tables.contains(table),
                "Sharing may name only an owned table"
            );
            if let TableAccess::OwnerOrShare {
                resource_type,
                share_key,
            } = access
            {
                ensure!(
                    identifier(resource_type)
                        && !share_key.is_empty()
                        && share_key.len() <= 63
                        && share_key
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                    "Invalid sharing declaration"
                );
                ensure!(
                    resource_type == &self.id
                        || resource_type.starts_with(&(self.id.clone() + ".")),
                    "New shared resource types must belong to this module"
                );
            }
        }
        for (queue, params) in &self.jobs {
            ensure!(
                identifier(queue) && params.keys().all(|s| identifier(s)),
                "Invalid job declaration"
            );
        }
        for route in &self.routes {
            ensure!(
                matches!(
                    route.method.as_str(),
                    "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
                ) && route.path.starts_with('/')
                    && (relative_path(&format!("route{}", route.path))
                        || crate::dispatch::template_path(&route.path))
                    && route.sign_in,
                "Module routes must be signed in and use safe paths"
            );
        }
        for namespace in &self.install_wide_kv {
            ensure!(
                self.capability("kv")?.resources.contains(namespace),
                "Install-wide storage must name an approved namespace"
            );
        }
        for (name, tool) in &self.tools {
            ensure!(
                crate::tool_names::valid(name)
                    && matches!(
                        tool.risk.as_str(),
                        "read" | "write" | "outbound" | "destructive"
                    )
                    && !tool.description.is_empty(),
                "Invalid tool declaration"
            );
        }
        for cred in self.credentials.values() {
            if let Some(exchange) = &cred.exchange {
                let url = url::Url::parse(&exchange.endpoint)?;
                ensure!(
                    url.scheme() == "https"
                        && url.port_or_known_default() == Some(443)
                        && cred.hosts.contains(url.host_str().unwrap_or(""))
                        && matches!(
                            exchange.grant_type.as_str(),
                            "client_credentials" | "refresh_token"
                        ),
                    "Invalid token exchange declaration"
                );
            }
            ensure!(
                !cred.hosts.is_empty(),
                "A credential needs an exact destination"
            );
            for host in &cred.hosts {
                validate_host(host)?;
            }
        }
        // AI is a capability request, never a provider/model selection field.
        reject_model_fields(&serde_json::to_value(self)?)?;
        Ok(())
    }
    pub fn capability(&self, port: &str) -> Result<&Capability> {
        self.capabilities
            .iter()
            .find(|c| c.port == port)
            .ok_or_else(|| anyhow::anyhow!("The module did not declare this permission"))
    }
    pub fn newly_requested(&self, old: &Self) -> Vec<Permission> {
        self.permissions()
            .into_iter()
            .filter(|p| {
                let new = self.capability(&p.port).expect("permission");
                !old.capability(&p.port).is_ok_and(|c| {
                    new.operations.is_subset(&c.operations)
                        && new.resources.is_subset(&c.resources)
                        && (!new.allow_private || c.allow_private)
                        && self.permission_metadata(&p.port) == old.permission_metadata(&p.port)
                })
            })
            .collect()
    }
    fn permission_metadata(&self, port: &str) -> Vec<String> {
        match port {
            "attachments" => {
                vec!["Only attachments you hand to this module in your account".into()]
            }
            "credentials" => self
                .credentials
                .iter()
                .map(|(name, c)| {
                    format!(
                        "Credential {name}: {}",
                        serde_json::to_string(c).expect("credential")
                    )
                })
                .collect(),
            "tools" | "action-policy" => self
                .tools
                .iter()
                .map(|(name, t)| format!("Tool {name}: {}", t.risk))
                .collect(),
            "db" => vec![format!(
                "Sharing: {}",
                serde_json::to_string(&self.database.access).expect("sharing")
            )],
            "kv" => self
                .install_wide_kv
                .iter()
                .map(|name| format!("Shared across accounts on this install: {name}"))
                .collect(),
            _ => vec![],
        }
    }
    pub fn permissions(&self) -> Vec<Permission> {
        self.capabilities
            .iter()
            .map(|cap| {
                let (group, headline) = match cap.port.as_str() {
                    "db" | "kv" => ("data", "Store and read this module's data"),
                    "vault" | "attachments" => ("files", "Read the files you give this module"),
                    "fetch" | "credentials" => ("network", "Contact approved services"),
                    "ai" | "embed" => ("AI", "Use your chosen AI service"),
                    "tools" | "action-policy" => {
                        ("chat tools", "Offer tools under your approval rules")
                    }
                    _ => ("data", "Work with your Moss account"),
                };
                Permission {
                    port: cap.port.clone(),
                    group: group.into(),
                    headline: headline.into(),
                    details: self
                        .permission_metadata(&cap.port)
                        .into_iter()
                        .chain(cap.resources.iter().cloned())
                        .chain(std::iter::once(format!(
                            "Operations: {}",
                            cap.operations
                                .iter()
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(", ")
                        )))
                        .chain(
                            cap.allow_private
                                .then(|| "Can contact devices on private networks".to_string()),
                        )
                        .collect(),
                    operations: cap.operations.clone(),
                    allow_private: cap.allow_private,
                }
            })
            .collect()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub port: String,
    pub group: String,
    pub headline: String,
    pub details: Vec<String>,
    pub operations: BTreeSet<String>,
    pub allow_private: bool,
}
pub fn validate_host(host: &str) -> Result<()> {
    let parsed = url::Url::parse(&format!("https://{host}"))?;
    ensure!(
        parsed.host_str() == Some(host)
            && parsed.port().is_none()
            && parsed.path() == "/"
            && parsed.username().is_empty()
            && parsed.password().is_none(),
        "Network destinations must be exact host names"
    );
    Ok(())
}
fn reject_model_fields(value: &Value) -> Result<()> {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "provider" | "model" | "modelname" | "providerid" | "modelid"
                ) {
                    bail!("Modules must request AI capabilities, not providers or models");
                }
                reject_model_fields(value)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_model_fields(item)?;
            }
        }
        _ => (),
    }
    Ok(())
}
