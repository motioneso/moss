//! Host-only chat policy, grant and redaction operations over the existing account store.
use crate::{
    manifest::{CredentialScope, Manifest},
    services::{tool_key, ServicePorts},
};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
impl ServicePorts {
    pub(crate) fn chat_policy(
        &self,
        module: &str,
        access: &AccessContext,
        tool: &str,
    ) -> Result<Option<bool>> {
        Ok(self.read(module, access, "action-policy")?[tool].as_bool())
    }
    pub(crate) fn approved_chat_payload(
        &self,
        module: &str,
        access: &AccessContext,
        tool: &str,
        params: &Value,
        pinned: bool,
        version: Option<&str>,
    ) -> Result<Value> {
        ensure!(
            !pinned || version.is_some(),
            "Displayed approval version required"
        );
        ensure!(
            version.is_none_or(|v| !v.is_empty() && v.len() <= 256),
            "Invalid approval version"
        );
        let _guard = self.serial_lock()?;
        let key = tool_key(tool, params)?;
        self.write(
            module,
            access,
            &key,
            &json!({"expires":chrono::Utc::now().timestamp()+300,"version":version}),
        )?;
        let mut payload = json!({"tool":tool,"parameters":params});
        self.consume_tool_approval(module, access, tool, params, pinned, &mut payload)?;
        Ok(payload)
    }
    // The caller holds serial_lock, across both mint (when applicable) and consumption.
    pub(crate) fn consume_tool_approval(
        &self,
        module: &str,
        access: &AccessContext,
        tool: &str,
        params: &Value,
        pinned: bool,
        payload: &mut Value,
    ) -> Result<()> {
        let key = tool_key(tool, params)?;
        let grant = self.read(module, access, &key)?;
        ensure!(
            grant["expires"]
                .as_i64()
                .is_some_and(|t| t > chrono::Utc::now().timestamp()),
            "This tool needs the account's approval"
        );
        if pinned {
            let version = grant["version"]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 256)
                .context("This tool needs the account's approval at its displayed version")?;
            payload["approvalVersion"] = json!(version);
        }
        self.write(module, access, &key, &Value::Null)?;
        Ok(())
    }
    pub(crate) fn sanitize_chat(
        &self,
        manifest: &Manifest,
        access: &AccessContext,
        value: &mut Value,
    ) -> Result<()> {
        let instance = AccessContext::new(uuid::Uuid::nil(), "instance-credential");
        let mut fields = Vec::new();
        for (name, credential) in &manifest.credentials {
            let access = if credential.scope == CredentialScope::Instance {
                &instance
            } else {
                access
            };
            // Absence is normal. A corrupt/unreadable envelope must not silently disable redaction.
            if !self
                .read(&manifest.id, access, &format!("credential-{name}"))?
                .is_null()
            {
                fields.push(
                    self.credential(access, &manifest.id, name)
                        .map_err(|_| anyhow::anyhow!("Chat credential redaction unavailable"))?,
                );
            }
        }
        crate::credentials::sanitize_with(
            value,
            &fields.iter().collect::<Vec<_>>(),
            &Default::default(),
        );
        Ok(())
    }
}
