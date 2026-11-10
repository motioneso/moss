//! Static package screens. Assets contain package code, never account data; the signed-in
//! parent owns API calls. Servers must use the configured trusted origin for AssetPolicy,
//! never an unchecked Host/Forwarded header, and apply every returned header.
use crate::{
    archive::Package,
    manifest::{identifier, relative_path},
    store::Installer,
};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use std::collections::BTreeMap;

pub const SANDBOX: &str = "allow-scripts allow-forms";
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub title: String,
    pub src: String,
    pub sandbox: String,
}
/// One main-navigation entry an installed module offers the signed-in account.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NavEntry {
    pub module: String,
    pub label: String,
    pub path: String,
    /// Lucide icon in kebab-case, for example `square-check-big`.
    pub icon: String,
}
fn kebab(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}
pub struct Asset {
    pub body: Vec<u8>,
    pub content_type: &'static str,
    pub headers: BTreeMap<String, String>,
}
pub struct AssetPolicy {
    origin: String,
}
impl AssetPolicy {
    pub fn new(trusted_origin: &str) -> Result<Self> {
        let url = url::Url::parse(trusted_origin)?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "A configured web origin is required"
        );
        Ok(Self {
            origin: url.origin().ascii_serialization(),
        })
    }
    fn headers(&self, id: &str, digest: &str) -> BTreeMap<String, String> {
        let base = format!("{}/module-ui/{id}/{digest}/ui/", self.origin);
        let shared = format!("{}/module-shared/", self.origin);
        BTreeMap::from([
            ("Content-Security-Policy".into(),format!("default-src 'none'; sandbox allow-scripts allow-forms; script-src {base} 'wasm-unsafe-eval'; style-src {base} {shared}park-press.css; style-src-attr 'unsafe-inline'; connect-src {base}; img-src {base}; font-src {shared}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")),
            ("Access-Control-Allow-Origin".into(),"null".into()),
            ("Cross-Origin-Resource-Policy".into(),"cross-origin".into()),
            ("X-Content-Type-Options".into(),"nosniff".into()),
            ("Referrer-Policy".into(),"no-referrer".into()),
            ("Cache-Control".into(),"no-store".into()),
        ])
    }
}
impl Installer {
    // Caller holds the catalog/disk read fence. Recheck activation and every installed byte,
    // just as code dispatch does, including UI-only packages.
    fn verified_ui_package(&self, id: &str, digest: Option<&str>) -> Result<Package> {
        ensure!(identifier(id), "Invalid module id");
        ensure!(
            !self.root.path().join("operation.json").exists(),
            "Module recovery must finish first"
        );
        let state = self.catalog.load()?;
        let installed = state.installed.get(id).context("Module is not installed")?;
        ensure!(installed.disabled.is_none(), "Module is disabled");
        ensure!(
            digest.is_none_or(|d| d == installed.digest),
            "This screen version is no longer active"
        );
        let package = self.read_package(&installed.digest)?;
        let dir = self
            .root
            .subdir("installed")?
            .subdir(id)?
            .subdir(&installed.manifest.version.to_string())?;
        for (path, expected) in &package.files {
            ensure!(
                dir.read(path)? == *expected,
                "The installed module changed on disk"
            );
        }
        Ok(package)
    }
    /// Navigation entries of installed, enabled modules for this account, ordered by the
    /// manifest's `order` then label. Only entries that open a declared screen are listed.
    pub fn navigation(&self, access: &AccessContext) -> Result<Vec<NavEntry>> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let state = self.catalog.load()?;
        let mut entries: Vec<(i64, NavEntry)> = Vec::new();
        for (id, installed) in &state.installed {
            let manifest = &installed.manifest;
            if installed.disabled.is_some()
                || !self
                    .lifecycle
                    .account_enabled(id, access, manifest.accounts.default_enabled)?
            {
                continue;
            }
            for value in &manifest.navigation {
                let text = |key: &str| value.get(key).and_then(|v| v.as_str());
                let (Some(label), Some(path)) = (text("label"), text("path")) else {
                    continue;
                };
                if !manifest.screens.contains_key(path) {
                    continue;
                }
                let order = value.get("order").and_then(|v| v.as_i64()).unwrap_or(1000);
                entries.push((
                    order,
                    NavEntry {
                        module: id.clone(),
                        label: label.into(),
                        path: path.into(),
                        icon: kebab(text("icon").unwrap_or("package")),
                    },
                ));
            }
        }
        entries.sort_by(|a, b| (a.0, &a.1.label).cmp(&(b.0, &b.1.label)));
        Ok(entries.into_iter().map(|(_, e)| e).collect())
    }
    /// Called after host sign-in. UI-only packages can open screens without a code handler.
    pub fn screen(&self, access: &AccessContext, id: &str, path: &str) -> Result<Screen> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let package = self.verified_ui_package(id, None)?;
        ensure!(
            self.lifecycle.account_enabled(
                id,
                access,
                package.manifest.accounts.default_enabled
            )?,
            "Module is switched off for this account"
        );
        let file = package
            .manifest
            .screens
            .get(path)
            .context("Screen is not declared")?;
        ensure!(package.files.contains_key(file), "Screen file is missing");
        Ok(Screen {
            title: package.manifest.name,
            src: format!("/module-ui/{id}/{}/{file}", package.digest),
            sandbox: SANDBOX.into(),
        })
    }
    /// Public static bytes only. Opaque-frame subresources carry no account credentials.
    /// Private data must go through the parent's signed-in bridge and module dispatch.
    pub fn ui_asset(
        &self,
        id: &str,
        digest: &str,
        path: &str,
        policy: &AssetPolicy,
    ) -> Result<Asset> {
        ensure!(
            path.starts_with("ui/") && relative_path(path),
            "Only safe UI assets can be served"
        );
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let package = self.verified_ui_package(id, Some(digest))?;
        let body = package
            .files
            .get(path)
            .context("UI asset is missing")?
            .clone();
        let content_type = match path.rsplit('.').next().unwrap_or("") {
            "html" => "text/html; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "js" | "mjs" => "text/javascript; charset=utf-8",
            "wasm" => "application/wasm",
            "json" => "application/json",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
        Ok(Asset {
            body,
            content_type,
            headers: policy.headers(id, digest),
        })
    }
}
