//! Host-only token exchange and broker. No credential values or response headers cross WIT.
use crate::{
    manifest::{wire_name, Attachment, Credential, CredentialScope},
    runtime::{CallScope, Request},
    services::ServicePorts,
};
use anyhow::{ensure, Context, Result};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Method,
};
use safety_core::secret::{Secret, SecretFields};
use serde_json::{json, Value};
use std::collections::BTreeSet;
impl ServicePorts {
    pub(crate) fn broker(&self, scope: &CallScope, r: &Request) -> Result<Value> {
        crate::runtime::authorize(scope.module(), "credentials", r)?;
        let name = r.parameters["credential"]
            .as_str()
            .context("Credential name required")?;
        let declaration = scope
            .module()
            .credentials
            .get(name)
            .context("Undeclared credential")?;
        // Instance credentials are configured through a separate host-owned account, not the
        // caller's UUID. Guests cannot choose that UUID or read the shared encrypted envelope.
        let instance = access_context::AccessContext::new(uuid::Uuid::nil(), "instance-credential");
        let access = if declaration.scope == CredentialScope::Instance {
            &instance
        } else {
            scope.access()
        };
        let slot = slot(r)?;
        if r.operation == "status" {
            // Read-only, so it takes no lock and never waits behind a running request.
            // Only whether every needed value is saved. The values and fields stay here.
            let configured = self
                .credential(access, &scope.module().id, name)
                .is_ok_and(|f| configured(declaration, &f, slot));
            return Ok(json!({"configured":configured}));
        }
        let _lock = self.credential_lock(&scope.module().id, access.actor_user_id(), name)?;
        if r.operation == "forget" {
            // Drops one stored token, leaving the others. A missing credential is not an error.
            let Ok(fields) = self.credential(access, &scope.module().id, name) else {
                return Ok(json!({"forgotten":false}));
            };
            let key = token_key(slot);
            let had = fields.get(&key).is_some();
            self.store_credential(
                access,
                &scope.module().id,
                name,
                &keep_except(&fields, &key),
            )?;
            return Ok(json!({"forgotten":had}));
        }
        let swap = declaration
            .exchange
            .as_ref()
            .is_some_and(|e| e.grant_type == "token_swap");
        // A first token swap starts from nothing. Any other failure to open the stored
        // credential must stop here, or a read error would overwrite the tokens already saved.
        let mut fields = match self.credential(access, &scope.module().id, name) {
            Ok(fields) => fields,
            Err(_)
                if swap
                    && r.operation == "exchange"
                    && self.read(&scope.module().id, access, &format!("credential-{name}"))?
                        == Value::Null =>
            {
                SecretFields::new()
            }
            Err(error) => return Err(error),
        };
        let url = url::Url::parse(r.parameters["url"].as_str().context("URL required")?)?;
        ensure!(
            declaration.hosts.contains(url.host_str().unwrap_or("")),
            "Credential destination not bound"
        );
        // Companion credentials ride along, each bound to this same destination.
        let mut companions = Vec::new();
        for companion in &declaration.with {
            let other = &scope.module().credentials[companion];
            ensure!(
                other.hosts.contains(url.host_str().unwrap_or("")),
                "Credential destination not bound"
            );
            let context = if other.scope == CredentialScope::Instance {
                &instance
            } else {
                scope.access()
            };
            companions.push((
                other,
                self.credential(context, &scope.module().id, companion)?,
            ));
        }
        if r.operation == "exchange" {
            let exchange = declaration
                .exchange
                .as_ref()
                .context("Token exchange not declared")?;
            if swap {
                let target = url::Url::parse(&exchange.endpoint)?;
                ensure!(
                    url.path() == target.path(),
                    "Token exchange destination not declared"
                );
                return self.token_swap(
                    scope,
                    declaration,
                    &companions,
                    &mut fields,
                    &url,
                    slot,
                    r,
                );
            }
            ensure!(
                url.as_str() == exchange.endpoint,
                "Token exchange destination not declared"
            );
            self.exchange(scope, name, access, &mut fields)?;
            return Ok(json!({"connected":true}));
        }
        if fields
            .get("expires")
            .and_then(|v| v.expose_secret().parse::<i64>().ok())
            .is_some_and(|t| t <= chrono::Utc::now().timestamp() + 30)
        {
            self.exchange(scope, name, access, &mut fields)?;
        }
        let mut headers = HeaderMap::new();
        let mut body = r.parameters.get("body").cloned();
        attach(
            &declaration.attachment,
            &fields,
            slot,
            &mut headers,
            &mut body,
        )?;
        for (other, other_fields) in &companions {
            attach(
                &other.attachment,
                other_fields,
                slot,
                &mut headers,
                &mut body,
            )?;
        }
        let method = r.parameters["method"]
            .as_str()
            .unwrap_or("GET")
            .parse::<Method>()?;
        let response = self.network.send(crate::network::Outbound {
            url: &url,
            hosts: &declaration.hosts,
            allow_private: scope.module().capability("credentials")?.allow_private,
            method,
            headers,
            body,
            timeout: scope.remaining(),
        })?;
        let mut value: Value = serde_json::from_slice(&response.body)
            .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&response.body)}));
        let mut secrets = vec![&fields];
        secrets.extend(companions.iter().map(|(_, f)| f));
        sanitize_with(&mut value, &secrets, &declaration.expose_fields);
        Ok(json!({"status":response.status,"body":value}))
    }
    /// Exchanges a short-lived code the module supplies for a lasting token. The host adds the
    /// companion fields (the client keys), stores the token under `slot` and answers with the
    /// reply minus every secret-looking field.
    #[allow(clippy::too_many_arguments)]
    fn token_swap(
        &self,
        scope: &CallScope,
        declaration: &Credential,
        companions: &[(&Credential, SecretFields)],
        fields: &mut SecretFields,
        url: &url::Url,
        slot: Option<&str>,
        r: &Request,
    ) -> Result<Value> {
        let exchange = declaration.exchange.as_ref().expect("declared exchange");
        let input = exchange.input.as_deref().expect("declared input");
        let given = r.parameters["input"].as_str().unwrap_or_default();
        ensure!(
            !given.is_empty() && given.len() <= 2048,
            "The exchange needs its input"
        );
        let mut body = Some(json!({ input: given }));
        let mut headers = HeaderMap::new();
        for (other, other_fields) in companions {
            attach(
                &other.attachment,
                other_fields,
                slot,
                &mut headers,
                &mut body,
            )?;
        }
        if exchange.format.as_deref() == Some("form") || exchange.format.is_none() {
            headers.insert(
                reqwest::header::CONTENT_TYPE,
                HeaderValue::from_static("application/x-www-form-urlencoded"),
            );
        }
        let response = self.network.send(crate::network::Outbound {
            url,
            hosts: &declaration.hosts,
            allow_private: scope.module().capability("credentials")?.allow_private,
            method: Method::POST,
            headers,
            body,
            timeout: scope.remaining(),
        })?;
        let mut result: Value = serde_json::from_slice(&response.body)
            .map_err(|_| anyhow::anyhow!("Invalid token exchange response"))?;
        if !(200..300).contains(&response.status) {
            // Only the provider's upper-case error code is repeated. Its prose can echo input.
            let code = result["error_code"]
                .as_str()
                .filter(|c| {
                    !c.is_empty()
                        && c.len() <= 80
                        && c.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
                })
                .unwrap_or("none");
            return Ok(json!({"connected":false,"error":code}));
        }
        let token = result["access_token"]
            .as_str()
            .context("Token exchange returned no access token")?
            .to_owned();
        let key = token_key(slot);
        let next = keep_except(fields, &key).with(key, Secret::new(token));
        // The token is saved before the reply goes anywhere, and the reply never holds it.
        let access = if declaration.scope == CredentialScope::Instance {
            access_context::AccessContext::new(uuid::Uuid::nil(), "instance-credential")
        } else {
            scope.access().clone()
        };
        let name = r.parameters["credential"].as_str().expect("checked name");
        self.store_credential(&access, &scope.module().id, name, &next)?;
        *fields = next;
        let mut secrets = vec![&*fields];
        secrets.extend(companions.iter().map(|(_, f)| f));
        sanitize_with(&mut result, &secrets, &declaration.expose_fields);
        Ok(json!({"connected":true,"body":result}))
    }
    fn exchange(
        &self,
        scope: &CallScope,
        name: &str,
        access: &access_context::AccessContext,
        fields: &mut SecretFields,
    ) -> Result<()> {
        let declaration = &scope.module().credentials[name];
        let exchange = declaration
            .exchange
            .as_ref()
            .context("Token exchange not declared")?;
        let mut body = json!({"grant_type":exchange.grant_type});
        for (stored, wire) in [("clientId", "client_id"), ("clientSecret", "client_secret")] {
            if let Some(value) = fields.get(stored) {
                body[wire] = json!(value.expose_secret());
            }
        }
        if let Some(token) = fields.get("refreshToken") {
            body["grant_type"] = json!("refresh_token");
            body["refresh_token"] = json!(token.expose_secret());
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        let response = self.network.send(crate::network::Outbound {
            url: &url::Url::parse(&exchange.endpoint)?,
            hosts: &declaration.hosts,
            allow_private: scope.module().capability("credentials")?.allow_private,
            method: Method::POST,
            headers,
            body: Some(body),
            timeout: scope.remaining(),
        })?;
        ensure!(
            (200..300).contains(&response.status),
            "Token exchange failed"
        );
        let result: Value = serde_json::from_slice(&response.body)
            .map_err(|_| anyhow::anyhow!("Invalid token exchange response"))?;
        let token = result["access_token"]
            .as_str()
            .context("Token exchange returned no access token")?;
        let mut next = SecretFields::new();
        for key in fields.names() {
            if !matches!(key, "accessToken" | "refreshToken" | "expires") {
                next = next.with(
                    key,
                    Secret::new(fields.get(key).expect("field").expose_secret()),
                );
            }
        }
        next = next.with("accessToken", Secret::new(token));
        if let Some(refresh) = result["refresh_token"]
            .as_str()
            .or_else(|| fields.get("refreshToken").map(|s| s.expose_secret()))
        {
            next = next.with("refreshToken", Secret::new(refresh));
        }
        let expires = result["expires_in"]
            .as_i64()
            .unwrap_or(3600)
            .clamp(1, 31_536_000)
            + chrono::Utc::now().timestamp();
        next = next.with("expires", Secret::new(expires.to_string()));
        self.store_credential(access, &scope.module().id, name, &next)?;
        *fields = next;
        Ok(())
    }
}
fn slot(r: &Request) -> Result<Option<&str>> {
    match r.parameters.get("slot") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if wire_name(s) => Ok(Some(s)),
        _ => anyhow::bail!("Invalid credential slot"),
    }
}
/// Stored field that holds the lasting token. A slot keeps one token per linked service.
fn token_key(slot: Option<&str>) -> String {
    slot.map_or_else(|| "accessToken".to_owned(), |s| format!("accessToken:{s}"))
}
fn keep_except(fields: &SecretFields, drop: &str) -> SecretFields {
    let mut next = SecretFields::new();
    for key in fields.names().filter(|k| *k != drop) {
        next = next.with(
            key,
            Secret::new(fields.get(key).expect("field").expose_secret()),
        );
    }
    next
}
fn configured(declaration: &Credential, fields: &SecretFields, slot: Option<&str>) -> bool {
    let present = |name: &str| {
        fields
            .get(name)
            .is_some_and(|v| !v.expose_secret().trim().is_empty())
    };
    match &declaration.attachment {
        Attachment::Fields(map) => map.values().all(|stored| {
            present(&if stored == "accessToken" {
                token_key(slot)
            } else {
                stored.clone()
            })
        }),
        _ => present(&token_key(slot)) || present("value"),
    }
}
/// Puts a stored credential on the outgoing request in the way its declaration allows.
fn attach(
    attachment: &Attachment,
    fields: &SecretFields,
    slot: Option<&str>,
    headers: &mut HeaderMap,
    body: &mut Option<Value>,
) -> Result<()> {
    let value = fields.get(&token_key(slot)).or_else(|| fields.get("value"));
    match attachment {
        Attachment::Header(header) => {
            let value = value.context("Credential value not configured")?;
            let mut header_value = HeaderValue::from_str(value.expose_secret())?;
            header_value.set_sensitive(true);
            headers.insert(HeaderName::from_bytes(header.as_bytes())?, header_value);
        }
        Attachment::Basic => {
            use base64::Engine;
            let user = fields
                .get("username")
                .context("Basic username required")?
                .expose_secret();
            let password = fields
                .get("password")
                .context("Basic password required")?
                .expose_secret();
            let mut header_value = HeaderValue::from_str(&format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
            ))?;
            header_value.set_sensitive(true);
            headers.insert(reqwest::header::AUTHORIZATION, header_value);
        }
        Attachment::Body(field) => {
            let values = body
                .get_or_insert_with(|| json!({}))
                .as_object_mut()
                .context("Credential body must be an object")?;
            values.insert(
                field.clone(),
                json!(value.context("Credential value required")?.expose_secret()),
            );
        }
        Attachment::Fields(map) => {
            let values = body
                .get_or_insert_with(|| json!({}))
                .as_object_mut()
                .context("Credential body must be an object")?;
            for (wire, stored) in map {
                let stored = if stored == "accessToken" {
                    token_key(slot)
                } else {
                    stored.clone()
                };
                // Set last, so a module cannot pre-fill or override an attached field.
                values.insert(
                    wire.clone(),
                    json!(fields
                        .get(&stored)
                        .context("Credential value required")?
                        .expose_secret()),
                );
            }
        }
    }
    Ok(())
}
pub(crate) fn sanitize_with(
    value: &mut Value,
    fields: &[&SecretFields],
    expose: &BTreeSet<String>,
) {
    match value {
        Value::Object(object) => {
            let original = std::mem::take(object);
            for (name, mut child) in original {
                if sensitive_name(&name) && !expose.contains(&name) {
                    continue;
                }
                let mut key = Value::String(name);
                sanitize_with(&mut key, fields, expose);
                sanitize_with(&mut child, fields, expose);
                object.insert(key.as_str().expect("sanitized string").to_owned(), child);
            }
        }
        Value::Array(array) => {
            for child in array {
                sanitize_with(child, fields, expose);
            }
        }
        Value::String(text) => {
            use base64::Engine;
            for set in fields {
                if let (Some(user), Some(password)) = (set.get("username"), set.get("password")) {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(format!(
                        "{}:{}",
                        user.expose_secret(),
                        password.expose_secret()
                    ));
                    *text = text.replace(&encoded, "[redacted]");
                }
                for key in set.names() {
                    let secret = set.get(key).expect("secret").expose_secret();
                    if !secret.is_empty() {
                        *text = text.replace(secret, "[redacted]");
                        *text = text.replace(
                            &base64::engine::general_purpose::STANDARD.encode(secret),
                            "[redacted]",
                        );
                    }
                }
            }
        }
        _ => (),
    }
}
fn sensitive_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase().replace(['-', '_'], "");
    ["token", "secret", "password", "authorization", "cookie"]
        .iter()
        .any(|part| name.contains(part))
}
