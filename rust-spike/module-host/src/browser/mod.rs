//! The host's browser port. Renders one page a person confirmed, in a sandboxed browser with no
//! network, and returns bounded evidence. Every page request goes through the safe fetch.
//!
//! Only a route call may use it. A scheduled job never opens a browser.
pub mod cdp;
pub mod evidence;
pub mod launch;
mod render;

use crate::{
    public_web::{PublicWeb, PUBLIC_WEB},
    runtime::{CallScope, Request},
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

/// Whole render, from start to evidence.
pub const DEADLINE: Duration = Duration::from_secs(20);
/// Page requests answered before the rest are refused.
pub const MAX_REQUESTS: usize = 40;
/// Page requests being fetched at one moment.
pub const MAX_CONCURRENT: usize = 4;
/// Link candidates returned.
pub const MAX_CANDIDATES: usize = 5;
/// All response bytes one render may take in.
pub const MAX_AGGREGATE_BYTES: usize = 10 * 1024 * 1024;
/// Largest single response a page may load.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Page text returned, in characters.
pub const TEXT_LIMIT: usize = 20_000;

/// Why a render did not produce evidence. Carries no page content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// This machine cannot run the browser the safe way. Nothing was opened.
    Unsupported,
    /// The request was not allowed, such as a job call or an unapproved address.
    Blocked,
    /// Another render is already running.
    Busy,
    Timeout,
    RenderFailed,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Unsupported => "unsupported",
            Reason::Blocked => "blocked",
            Reason::Busy => "busy",
            Reason::Timeout => "timeout",
            Reason::RenderFailed => "render_failed",
        }
    }
    pub fn to_json(self) -> Value {
        json!({"ok":false,"reason":self.as_str()})
    }
}

/// Proof only. Each switch removes one guard so a test can see the guard stop something.
#[cfg(feature = "browser-proof")]
#[derive(Clone, Copy, Default)]
pub struct Weakened {
    pub host_list: bool,
}

pub struct BrowserPort {
    #[cfg(feature = "browser-proof")]
    pub weakened: Weakened,
    launcher: launch::Launcher,
    web: Arc<PublicWeb>,
    /// Holds the slot for the one render that may run at a time.
    busy: Mutex<()>,
}

impl BrowserPort {
    pub fn new(chrome_dir: impl Into<PathBuf>, web: Arc<PublicWeb>) -> Self {
        Self::with_launcher(launch::Launcher::new(chrome_dir), web)
    }

    pub fn with_launcher(launcher: launch::Launcher, web: Arc<PublicWeb>) -> Self {
        Self {
            #[cfg(feature = "browser-proof")]
            weakened: Weakened::default(),
            launcher,
            web,
            busy: Mutex::new(()),
        }
    }

    /// Opens `parameters.url` and returns evidence, or a reason. Never returns an error, so a
    /// refusal reaches the package as a reason it can show.
    pub fn render(&self, scope: &CallScope, request: &Request) -> Value {
        match self.try_render(scope, request) {
            Ok(value) => value,
            Err(reason) => reason.to_json(),
        }
    }

    fn try_render(&self, scope: &CallScope, request: &Request) -> Result<Value, Reason> {
        if scope.kind() != "route"
            || request.operation != "render"
            || request.resource != PUBLIC_WEB
        {
            return Err(Reason::Blocked);
        }
        let map = request.parameters.as_object().ok_or(Reason::Blocked)?;
        if map.keys().any(|k| k != "url" && k != "allowedHosts") {
            return Err(Reason::Blocked);
        }
        let url = map
            .get("url")
            .and_then(Value::as_str)
            .and_then(|u| Url::parse(u).ok())
            .ok_or(Reason::Blocked)?;
        let allowed: Vec<String> = map
            .get("allowedHosts")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty() && a.len() <= 32)
            .ok_or(Reason::Blocked)?
            .iter()
            .map(|h| h.as_str().map(str::to_ascii_lowercase))
            .collect::<Option<_>>()
            .ok_or(Reason::Blocked)?;
        #[cfg(feature = "browser-proof")]
        let listed = self.weakened.host_list || render::approved(url.as_str(), &allowed);
        #[cfg(not(feature = "browser-proof"))]
        let listed = render::approved(url.as_str(), &allowed);
        if !listed {
            return Err(Reason::Blocked);
        }
        let _slot = self.busy.try_lock().map_err(|_| Reason::Busy)?;
        // Refuse before any browser starts when the machine cannot isolate it.
        self.launcher.check().map_err(|_| Reason::Unsupported)?;
        let deadline = (Instant::now() + DEADLINE).min(Instant::now() + scope.remaining());
        let page = render::Page {
            url,
            allowed_hosts: allowed,
            deadline,
            #[cfg(feature = "browser-proof")]
            skip_host_list: self.weakened.host_list,
        };
        let rendered = render::render(&self.launcher, &self.web, &page)?;
        Ok(rendered
            .evidence
            .to_json(&rendered.final_url, scope.access().request_id(), rendered.requests))
    }
}
