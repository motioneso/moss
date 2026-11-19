//! Server-side chat entry points. Turn/record matching belongs to the server, not this crate.
use crate::{
    chat_schema,
    manifest::{Manifest, Tool},
    store::Installer,
};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChatToolRule {
    Run,
    RunUnlessPolicy,
    Card { pinned: bool },
}
pub fn chat_tool_rule(tool: &Tool, explicit_policy: Option<bool>) -> ChatToolRule {
    if tool.approval_version || matches!(tool.risk.as_str(), "destructive" | "outbound") {
        ChatToolRule::Card {
            pinned: tool.approval_version,
        }
    } else if tool.risk == "read" {
        ChatToolRule::Run
    } else if tool.risk == "write" && explicit_policy != Some(true) {
        ChatToolRule::RunUnlessPolicy
    } else {
        ChatToolRule::Card { pinned: false }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChatToolDef {
    pub module: String,
    pub tool: String,
    pub wire_name: String,
    pub description: String,
    pub input_schema: Value,
    pub risk: String,
    pub rule: ChatToolRule,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CardField {
    pub label: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ApprovalCardRecord {
    pub title: String,
    pub target: String,
    pub fields: Vec<CardField>,
    pub version: Option<String>,
    pub content: Option<String>,
    pub danger: bool,
}
// Module adapters build labels in code; only the manifest supplies the fixed target.
fn normalize_card(manifest: &Manifest, tool: &Tool, raw: Value) -> Result<ApprovalCardRecord> {
    ensure!(
        raw.to_string().len() <= 32 * 1024,
        "Approval card too large"
    );
    let object = raw.as_object().context("Invalid approval card")?;
    let text = |key: &str, max: usize| -> Result<Option<String>> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if !s.is_empty() && s.len() <= max => Ok(Some(s.clone())),
            _ => anyhow::bail!("Invalid approval card field"),
        }
    };
    let mut fields = Vec::new();
    if let Some(item) = text("target", 4096)? {
        fields.push(CardField {
            label: "Item".into(),
            value: item,
        });
    }
    let values = raw["fields"].as_array().context("Card fields required")?;
    ensure!(values.len() <= 32, "Too many card fields");
    for field in values {
        let field: CardField = serde_json::from_value(field.clone())?;
        ensure!(
            !field.label.is_empty() && field.label.len() <= 120 && field.value.len() <= 4096,
            "Invalid card field size"
        );
        fields.push(field);
    }
    let version = text("version", 256)?;
    ensure!(
        !tool.approval_version || version.is_some(),
        "Pinned card version required"
    );
    let target = format!("{}: {}", manifest.name, tool.description);
    ensure!(target.len() <= 1024, "Card target too long");
    Ok(ApprovalCardRecord {
        title: "Action request".into(),
        target,
        fields,
        version,
        content: text("content", 8192)?,
        danger: matches!(tool.risk.as_str(), "destructive" | "outbound"),
    })
}
impl Installer {
    fn chat_services(&self) -> Result<std::sync::Arc<crate::services::ServicePorts>> {
        self.chat_services
            .read()
            .map_err(|_| anyhow::anyhow!("Chat services are busy"))?
            .upgrade()
            .context("Chat services are not connected")
    }
    pub fn chat_tools(&self, access: &AccessContext) -> Result<Vec<ChatToolDef>> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let services = self.chat_services()?;
        let state = self.catalog.load()?;
        let mut names = BTreeSet::new();
        let mut out = Vec::new();
        for (id, installed) in &state.installed {
            let manifest = &installed.manifest;
            if installed.disabled.is_some()
                || !self
                    .lifecycle
                    .account_enabled(id, access, manifest.accounts.default_enabled)?
            {
                continue;
            }
            for (name, tool) in &manifest.tools {
                let Some(schema) = &tool.input_schema else {
                    continue;
                };
                let mut value = serde_json::to_value(ChatToolDef {
                    module: id.clone(),
                    tool: name.clone(),
                    wire_name: name.replace('.', "_"),
                    description: tool.description.clone(),
                    input_schema: schema.clone(),
                    risk: tool.risk.clone(),
                    rule: chat_tool_rule(tool, services.chat_policy(id, access, name)?),
                })?;
                services.sanitize_chat(manifest, access, &mut value)?;
                let def: ChatToolDef = serde_json::from_value(value)?;
                // Never rename a callable identity as a side effect of redaction.
                if def.module != *id
                    || def.tool != *name
                    || def.wire_name != name.replace('.', "_")
                    || chat_schema::check(&def.input_schema).is_err()
                {
                    continue;
                }
                ensure!(
                    names.insert(def.wire_name.clone()),
                    "Duplicate chat tool name"
                );
                out.push(def);
            }
        }
        Ok(out)
    }
    fn chat_manifest(&self, module: &str, name: &str, params: &Value) -> Result<(Manifest, Tool)> {
        let state = self.catalog.load()?;
        let installed = state
            .installed
            .get(module)
            .context("Chat module unavailable")?;
        ensure!(installed.disabled.is_none(), "Chat module disabled");
        // call_unfenced rechecks the account switch immediately before guest dispatch.
        let manifest = installed.manifest.clone();
        let tool = manifest
            .tools
            .get(name)
            .context("Chat tool unavailable")?
            .clone();
        let schema = tool
            .input_schema
            .as_ref()
            .context("Chat tool has no input schema")?;
        ensure!(
            params.to_string().len() <= 64 * 1024,
            "Tool arguments too large"
        );
        chat_schema::validate(schema, params)?;
        Ok((manifest, tool))
    }
    pub fn run_chat_tool(
        &self,
        access: &AccessContext,
        module: &str,
        name: &str,
        params: Value,
    ) -> Result<Value> {
        self.run_chat(access, module, name, params, None)
    }
    /// Trusted caller must first match an approved server record to the open turn and exact params.
    pub fn run_approved_chat_tool(
        &self,
        access: &AccessContext,
        module: &str,
        name: &str,
        params: Value,
        version: Option<&str>,
    ) -> Result<Value> {
        self.run_chat(access, module, name, params, Some(version))
    }
    fn run_chat(
        &self,
        access: &AccessContext,
        module: &str,
        name: &str,
        params: Value,
        approved: Option<Option<&str>>,
    ) -> Result<Value> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let (manifest, tool) = self.chat_manifest(module, name, &params)?;
        let services = self.chat_services()?;
        let rule = chat_tool_rule(&tool, services.chat_policy(module, access, name)?);
        let payload = match (rule, approved) {
            (ChatToolRule::Card { .. }, None) => {
                anyhow::bail!("This chat tool needs an approval card")
            }
            (_, Some(version)) => services.approved_chat_payload(
                module,
                access,
                name,
                &params,
                tool.approval_version,
                version,
            )?,
            _ => json!({"tool":name,"parameters":params}),
        };
        // Grant lock has been released: guest ports may re-enter ServicePorts.
        let result = self
            .call_unfenced(module, access.clone(), "tool", &payload.to_string())
            .map_err(|_| anyhow::anyhow!("Chat tool failed"))?;
        let mut value: Value = serde_json::from_str(&result)
            .map_err(|_| anyhow::anyhow!("Invalid chat tool reply"))?;
        services.sanitize_chat(&manifest, access, &mut value)?;
        Ok(value)
    }
    pub fn chat_tool_card(
        &self,
        access: &AccessContext,
        module: &str,
        name: &str,
        params: &Value,
    ) -> Result<Option<ApprovalCardRecord>> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let (manifest, tool) = self.chat_manifest(module, name, params)?;
        let Some(api) = &tool.card else {
            return Ok(None);
        };
        ensure!(manifest.provides.contains_key(api), "Card API unavailable");
        let payload = json!({"name":api,"parameters":{"tool":name,"parameters":params}});
        let card = (|| -> Result<ApprovalCardRecord> {
            let result = self.call_unfenced(module, access.clone(), "api", &payload.to_string())?;
            let raw: Value = serde_json::from_str(&result)?;
            let card = normalize_card(&manifest, &tool, raw)?;
            let mut value = serde_json::to_value(&card)?;
            self.chat_services()?
                .sanitize_chat(&manifest, access, &mut value)?;
            let clean: ApprovalCardRecord = serde_json::from_value(value)?;
            ensure!(
                card.version == clean.version,
                "Card version contains credential data"
            );
            Ok(clean)
        })();
        Ok(card.ok()) // Failed/malformed card is a denial, never a runnable fallback.
    }
}
