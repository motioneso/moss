//! Host-only token exchange and broker. No credential values or response headers cross WIT.
use crate::{
    manifest::{Attachment, CredentialScope},
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
        let mut fields = self.credential(access, &scope.module().id, name)?;
        let url = url::Url::parse(r.parameters["url"].as_str().context("URL required")?)?;
        ensure!(
            declaration.hosts.contains(url.host_str().unwrap_or("")),
            "Credential destination not bound"
        );
        if r.operation == "exchange" {
            let exchange = declaration
                .exchange
                .as_ref()
                .context("Token exchange not declared")?;
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
        let value = fields.get("accessToken").or_else(|| fields.get("value"));
        let mut headers = HeaderMap::new();
        let mut body = r.parameters.get("body").cloned();
        match &declaration.attachment {
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
        }
        let method = r.parameters["method"]
            .as_str()
            .unwrap_or("GET")
            .parse::<Method>()?;
        let response = crate::network::request(
            &url,
            &declaration.hosts,
            scope.module().capability("credentials")?.allow_private,
            method,
            headers,
            body,
            scope.remaining(),
        )?;
        let mut value: Value = serde_json::from_slice(&response.body)
            .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&response.body)}));
        sanitize(&mut value, &fields);
        Ok(json!({"status":response.status,"body":value}))
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
        let response = crate::network::request(
            &url::Url::parse(&exchange.endpoint)?,
            &declaration.hosts,
            scope.module().capability("credentials")?.allow_private,
            Method::POST,
            HeaderMap::new(),
            Some(body),
            scope.remaining(),
        )?;
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
        self.set_credential(access, &scope.module().id, name, &next)?;
        *fields = next;
        Ok(())
    }
}
pub(crate) fn sanitize(value: &mut Value, fields: &SecretFields) {
    match value {
        Value::Object(object) => {
            object.retain(|name, _| !sensitive_name(name));
            for child in object.values_mut() {
                sanitize(child, fields);
            }
        }
        Value::Array(array) => {
            for child in array {
                sanitize(child, fields);
            }
        }
        Value::String(text) => {
            for key in fields.names() {
                let secret = fields.get(key).expect("secret").expose_secret();
                if !secret.is_empty() {
                    *text = text.replace(secret, "[redacted]");
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
