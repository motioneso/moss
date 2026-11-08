//! Concrete account services. Host-only files live beside module data, outside the guest's
//! vault subfolder, so lifecycle snapshots retain and purge them with the module.
use crate::{
    runtime::{CallScope, Ports, Request},
    store::Installer,
};
use access_context::AccessContext;
use anyhow::{bail, ensure, Context, Result};
use safety_core::secret::{SecretCipher, SecretFields};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex, RwLock, Weak},
};
use vault::{Root, VaultContext};

pub struct ServicePorts {
    pub(crate) files: Root,
    pub(crate) cipher: Arc<SecretCipher>,
    pub(crate) serial: Mutex<()>,
    installer: RwLock<Weak<Installer>>,
    next: Arc<dyn Ports>,
    pub(crate) ai: Arc<dyn crate::ai::Intelligence>,
}
impl ServicePorts {
    pub fn new(
        data: &Path,
        cipher: Arc<SecretCipher>,
        ai: Arc<dyn crate::ai::Intelligence>,
        next: Arc<dyn Ports>,
    ) -> Result<Self> {
        Ok(Self {
            files: Root::create(&data.join("modules/files"))?,
            cipher,
            serial: Mutex::new(()),
            installer: RwLock::new(Weak::new()),
            next,
            ai,
        })
    }
    pub fn bind(&self, installer: &Arc<Installer>) {
        *self.installer.write().expect("host binding") = Arc::downgrade(installer);
    }
    pub(crate) fn account(&self, id: &str, access: &AccessContext) -> Result<VaultContext> {
        ensure!(crate::manifest::identifier(id), "Invalid module id");
        let module = self.files.create_subdir(id)?;
        let cx = VaultContext::for_access(&module, access)?;
        cx.create_dir("host")?;
        Ok(cx)
    }
    pub(crate) fn read(&self, id: &str, access: &AccessContext, name: &str) -> Result<Value> {
        let account = self.account(id, access)?;
        match account.read(&format!("host/{name}.json")) {
            Ok(b) => Ok(serde_json::from_slice(&b)?),
            Err(vault::VaultError::NotFound(_)) => Ok(Value::Null),
            Err(e) => Err(e.into()),
        }
    }
    pub(crate) fn write(
        &self,
        id: &str,
        access: &AccessContext,
        name: &str,
        value: &Value,
    ) -> Result<()> {
        ensure!(crate::manifest::relative_path(name), "Invalid service file");
        let bytes = serde_json::to_vec(value)?;
        ensure!(
            bytes.len() <= 8 * 1024 * 1024,
            "Service data exceeds its limit"
        );
        Ok(self
            .account(id, access)?
            .write(&format!("host/{name}.json"), &bytes)?)
    }
    fn host(&self) -> Result<Arc<Installer>> {
        self.installer
            .read()
            .map_err(|_| anyhow::anyhow!("Host busy"))?
            .upgrade()
            .context("The host has not started")
    }
    /// Called by the signed-in host's upload route, never by a guest.
    pub fn hand_attachment(
        &self,
        access: &AccessContext,
        module: &str,
        bytes: &[u8],
        media_type: &str,
    ) -> Result<String> {
        ensure!(
            bytes.len() <= 1024 * 1024 && media_type.len() <= 100,
            "Attachment too large"
        );
        use base64::Engine;
        let id = uuid::Uuid::new_v4().to_string();
        self.write(module,access,&format!("attachment-{id}"),&json!({"mediaType":media_type,"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}))?;
        Ok(id)
    }
    /// Host-side credential configuration. No read-value method is reachable by a guest.
    pub fn set_credential(
        &self,
        access: &AccessContext,
        module: &str,
        name: &str,
        fields: &SecretFields,
    ) -> Result<()> {
        ensure!(crate::manifest::identifier(name), "Invalid credential name");
        self.write(
            module,
            access,
            &format!("credential-{name}"),
            &self.cipher.seal(fields),
        )
    }
    pub(crate) fn credential(
        &self,
        access: &AccessContext,
        module: &str,
        name: &str,
    ) -> Result<SecretFields> {
        let stored = self.read(module, access, &format!("credential-{name}"))?;
        self.cipher
            .open(&stored)
            .map_err(|_| anyhow::anyhow!("Configure this credential before using it"))
    }
    /// Host-side approval is bound to actor, module, tool and exact parameters. It is consumed
    /// once; a guest cannot create approvals or mark its own tool as harmless.
    pub fn approve_tool(
        &self,
        access: &AccessContext,
        module: &str,
        tool: &str,
        parameters: &Value,
    ) -> Result<()> {
        let _guard = self
            .serial
            .lock()
            .map_err(|_| anyhow::anyhow!("Service busy"))?;
        let key = tool_key(tool, parameters)?;
        self.write(
            module,
            access,
            &key,
            &json!({"expires":chrono::Utc::now().timestamp()+300}),
        )
    }
    pub fn set_action_policy(
        &self,
        access: &AccessContext,
        module: &str,
        policy: &BTreeMap<String, bool>,
    ) -> Result<()> {
        self.write(
            module,
            access,
            "action-policy",
            &serde_json::to_value(policy)?,
        )
    }
    fn invoke_service(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        let id = &scope.module().id;
        let access = scope.access();
        match port {
            "credentials" => self.broker(scope, r),
            "ai" => self.ai.generate(scope, r),
            "embed" => self.ai.embed(scope, r),
            "notify" => {
                ensure!(r.operation == "post", "Unknown notification operation");
                let text = r.parameters["text"]
                    .as_str()
                    .context("Notification text required")?;
                ensure!(text.len() <= 4096, "Notification too long");
                let key = format!("notification-{}", uuid::Uuid::new_v4());
                self.write(
                    id,
                    access,
                    &key,
                    &json!({"text":text,"created":chrono::Utc::now()}),
                )?;
                Ok(json!({"posted":true}))
            }
            "attachments" => {
                ensure!(
                    r.operation == "read" && uuid::Uuid::parse_str(&r.resource).is_ok(),
                    "Only handed attachments can be read"
                );
                let attachment = self.read(id, access, &format!("attachment-{}", r.resource))?;
                ensure!(
                    !attachment.is_null(),
                    "This account did not hand this attachment to this module"
                );
                Ok(attachment)
            }
            "action-policy" => {
                ensure!(
                    r.operation == "read" && scope.module().tools.contains_key(&r.resource),
                    "Unknown tool policy"
                );
                let policy = self.read(id, access, "action-policy")?;
                Ok(json!({"requiresApproval":policy[&r.resource].as_bool().unwrap_or(true)}))
            }
            "tools" => {
                let tool = scope
                    .module()
                    .tools
                    .get(&r.resource)
                    .context("Tool not declared")?;
                match r.operation.as_str() {
                    "offer" => Ok(serde_json::to_value(tool)?),
                    "run" => {
                        let params = r
                            .parameters
                            .get("parameters")
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        let required = tool.risk != "read"
                            || self.read(id, access, "action-policy")?[&r.resource]
                                .as_bool()
                                .unwrap_or(true);
                        if required {
                            let _guard = self
                                .serial
                                .lock()
                                .map_err(|_| anyhow::anyhow!("Service busy"))?;
                            let key = tool_key(&r.resource, &params)?;
                            let grant = self.read(id, access, &key)?;
                            ensure!(
                                grant["expires"]
                                    .as_i64()
                                    .is_some_and(|t| t > chrono::Utc::now().timestamp()),
                                "This tool needs the account's approval"
                            );
                            self.write(id, access, &key, &Value::Null)?;
                        }
                        self.host()?
                            .invoke_public(
                                id,
                                access.clone(),
                                "tool",
                                &json!({"tool":r.resource,"parameters":params}).to_string(),
                            )
                            .and_then(|s| Ok(serde_json::from_str(&s)?))
                    }
                    _ => bail!("Unknown tool operation"),
                }
            }
            "api" => {
                ensure!(r.operation == "call", "Unknown public API operation");
                let host = self.host()?;
                let state = host.catalog.load()?;
                let target = state
                    .installed
                    .get(&r.resource)
                    .context("The required module is not installed")?;
                ensure!(
                    scope
                        .module()
                        .requires
                        .get(&r.resource)
                        .is_some_and(|v| v.matches(&target.manifest.version)),
                    "The public API dependency is incompatible"
                );
                let api = r.parameters["name"]
                    .as_str()
                    .context("Public API name required")?;
                ensure!(
                    target.manifest.provides.contains_key(api),
                    "This API is not public"
                );
                host.invoke_public(
                    &r.resource,
                    access.clone(),
                    "route",
                    &r.parameters.to_string(),
                )
                .and_then(|s| Ok(serde_json::from_str(&s)?))
            }
            "events" => match r.operation.as_str() {
                "publish" => {
                    ensure!(
                        scope.module().provides.contains_key(&r.resource),
                        "Event not declared"
                    );
                    let _guard = self
                        .serial
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Service busy"))?;
                    let key = format!("event-{}", crate::trust::digest(r.resource.as_bytes()));
                    let mut entries = self
                        .read(id, access, &key)?
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    if entries.len() >= 256 {
                        entries.remove(0);
                    }
                    entries.push(json!({"id":uuid::Uuid::new_v4(),"data":r.parameters,"created":chrono::Utc::now()}));
                    self.write(id, access, &key, &Value::Array(entries))?;
                    Ok(json!({"published":true}))
                }
                "subscribe" | "poll" => {
                    let provider = r.parameters["module"]
                        .as_str()
                        .context("Event publisher required")?;
                    let host = self.host()?;
                    let state = host.catalog.load()?;
                    let provider_manifest = &state
                        .installed
                        .get(provider)
                        .context("Publisher unavailable")?
                        .manifest;
                    ensure!(
                        scope
                            .module()
                            .requires
                            .get(provider)
                            .is_some_and(|v| v.matches(&provider_manifest.version))
                            && provider_manifest.provides.contains_key(&r.resource),
                        "Event subscription not declared"
                    );
                    let key = format!(
                        "subscription-{}",
                        crate::trust::digest(format!("{provider}:{}", r.resource).as_bytes())
                    );
                    if r.operation == "subscribe" {
                        self.write(id, access, &key, &json!(true))?;
                        return Ok(json!({"subscribed":true}));
                    }
                    ensure!(
                        self.read(id, access, &key)? == json!(true),
                        "Subscribe before polling events"
                    );
                    self.read(
                        provider,
                        access,
                        &format!("event-{}", crate::trust::digest(r.resource.as_bytes())),
                    )
                }
                _ => bail!("Unknown event operation"),
            },
            _ => self.next.invoke(scope, port, r),
        }
    }
}
impl Ports for ServicePorts {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        crate::runtime::authorize(scope.module(), port, r)?;
        let result = self.invoke_service(scope, port, r);
        // Activity contains only declared resource names and status, never request/response data.
        if let Ok(_guard) = self.serial.lock() {
            let mut entries = self
                .read(&scope.module().id, scope.access(), "activity")
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            if entries.len() >= 256 {
                entries.remove(0);
            }
            entries.push(json!({"port":port,"operation":r.operation,"resource":r.resource,"success":result.is_ok(),"at":chrono::Utc::now()}));
            let _ = self.write(
                &scope.module().id,
                scope.access(),
                "activity",
                &Value::Array(entries),
            );
        }
        result
    }
}
fn tool_key(tool: &str, parameters: &Value) -> Result<String> {
    Ok(format!(
        "approval-{}",
        crate::trust::digest(&serde_json::to_vec(&(tool, parameters))?)
    ))
}
// Called only while an outer host invocation holds the lifecycle read fence. Bound recursion
// avoids cross-module call cycles without reacquiring a writer-preferring read lock.
thread_local! {static DEPTH:std::cell::Cell<u8>=const{std::cell::Cell::new(0)};}
impl Installer {
    pub(crate) fn invoke_public(
        &self,
        id: &str,
        access: AccessContext,
        kind: &str,
        payload: &str,
    ) -> Result<String> {
        struct DepthGuard;
        impl Drop for DepthGuard {
            fn drop(&mut self) {
                DEPTH.with(|d| d.set(d.get() - 1));
            }
        }
        DEPTH.with(|d| {
            ensure!(d.get() < 8, "Module call cycle limit reached");
            d.set(d.get() + 1);
            Ok::<_, anyhow::Error>(())
        })?;
        let _depth = DepthGuard;
        self.call_unfenced(id, access, kind, payload)
    }
}
