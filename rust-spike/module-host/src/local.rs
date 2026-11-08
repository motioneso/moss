//! Real host-local ports. Other services are joined through Ports, not imported into guests.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read, path::Path, sync::Mutex};
use vault::{Root, VaultContext};

pub struct LocalPorts {
    root: Root,
    serial: Mutex<()>,
}
impl LocalPorts {
    pub fn new(data: &Path) -> Result<Self> {
        Ok(Self {
            root: Root::create(&data.join("modules/files"))?,
            serial: Mutex::new(()),
        })
    }
}
impl Ports for LocalPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        let module = self.root.create_subdir(&scope.module().id)?;
        let account = VaultContext::for_access(&module, scope.access())?;
        match port {
            "kv" => {
                let _guard = self
                    .serial
                    .lock()
                    .map_err(|_| anyhow::anyhow!("The module data store is busy"))?;
                let mut values: BTreeMap<String, Value> = match account.read("kv.json") {
                    Ok(bytes) => serde_json::from_slice(&bytes)?,
                    Err(vault::VaultError::NotFound(_)) => BTreeMap::new(),
                    Err(e) => return Err(e.into()),
                };
                match request.operation.as_str() {
                    "get" => Ok(values
                        .get(&request.resource)
                        .cloned()
                        .unwrap_or(Value::Null)),
                    "set" => {
                        values.insert(request.resource.clone(), request.parameters.clone());
                        let bytes = serde_json::to_vec(&values)?;
                        ensure!(
                            bytes.len() <= 8 * 1024 * 1024,
                            "The module's key-value store is full"
                        );
                        account.write("kv.json", &bytes)?;
                        Ok(json!({"saved":true}))
                    }
                    "delete" => {
                        values.remove(&request.resource);
                        account.write("kv.json", &serde_json::to_vec(&values)?)?;
                        Ok(json!({"removed":true}))
                    }
                    _ => bail!("Unknown key-value operation"),
                }
            }
            "vault" => {
                // Internal key-value files and ordinary module files use separate folders.
                account.create_dir("vault")?;
                match request.operation.as_str() {
                    "read" => Ok(
                        json!({"text":account.read_to_string(&format!("vault/{}",request.resource))?}),
                    ),
                    "write" => {
                        let text = request.parameters["text"]
                            .as_str()
                            .context("File writes need text")?;
                        ensure!(text.len() <= 1024 * 1024, "The file is too large");
                        account.write(&format!("vault/{}", request.resource), text.as_bytes())?;
                        Ok(json!({"saved":true}))
                    }
                    _ => bail!("Unknown file operation"),
                }
            }
            "fetch" => {
                ensure!(
                    request.operation == "get",
                    "This local fetch adapter supports GET only"
                );
                let url = url::Url::parse(
                    request.parameters["url"]
                        .as_str()
                        .context("The request needs a URL")?,
                )?;
                let response = crate::registry::https_request(
                    &url,
                    scope.module().capability("fetch")?.allow_private,
                    scope.remaining(),
                )?;
                let mut bytes = Vec::new();
                response.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
                ensure!(bytes.len() <= 1024 * 1024, "The response is too large");
                Ok(json!({"body":String::from_utf8(bytes)?}))
            }
            _ => bail!("This service has not been connected to the module host"),
        }
    }
}
