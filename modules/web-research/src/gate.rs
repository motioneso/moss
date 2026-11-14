//! Which search engine a person gets, and why none when none. The order matches the old
//! resolver: a saved search key first, then the built-in model search switch, then the
//! person's chat model.
use moss_module_sdk::Host;
use serde_json::{json, Value};

/// The only host the saved search key may be sent to.
pub const BRAVE_HOST: &str = "api.search.brave.com";
/// The name of the saved search key in the manifest.
pub const BRAVE_KEY: &str = "braveSearch";
const NATIVE_SWITCH: &str = "native-search";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    NoKeyNoNativeModel,
    NativeDisabled,
    ModelHasNoSearch,
}
impl Reason {
    /// The strings the News settings screen already knows.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoKeyNoNativeModel => "no-key-no-native-model",
            Self::NativeDisabled => "native-disabled",
            Self::ModelHasNoSearch => "model-has-no-search",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Brave,
    ModelNative,
    None(Reason),
}
impl Engine {
    pub fn available(self) -> bool {
        !matches!(self, Self::None(_))
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Brave => "brave",
            Self::ModelNative => "model-native",
            Self::None(_) => "none",
        }
    }
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Self::None(reason) => Some(reason.as_str()),
            _ => None,
        }
    }
    /// The status the News screen and the `webSearchStatus` call show.
    pub fn status(self) -> Value {
        json!({"webSearchConfigured": self.available(), "engine": self.name(), "webSearchReason": self.reason()})
    }
}

/// `model` is `None` when the person has no chat model, else whether it can search the web.
pub fn decide(key_saved: bool, native_enabled: bool, model: Option<bool>) -> Engine {
    if key_saved {
        return Engine::Brave;
    }
    if !native_enabled {
        return Engine::None(Reason::NativeDisabled);
    }
    match model {
        None => Engine::None(Reason::NoKeyNoNativeModel),
        Some(true) => Engine::ModelNative,
        Some(false) => Engine::None(Reason::ModelHasNoSearch),
    }
}

fn key_saved<H: Host + ?Sized>(host: &H) -> bool {
    host.call("credentials", "status", BRAVE_HOST, json!({"credential": BRAVE_KEY}))
        .is_ok_and(|v| v["configured"] == true)
}

/// On unless an administrator turned it off. A missing or unreadable switch counts as on.
fn native_enabled<H: Host + ?Sized>(host: &H) -> bool {
    host.call("kv", "get", NATIVE_SWITCH, json!({}))
        .ok()
        .and_then(|v| v["enabled"].as_bool())
        .unwrap_or(true)
}

fn chat_model<H: Host + ?Sized>(host: &H) -> Option<bool> {
    let reply = host.call("ai", "capabilities", "chat", json!({})).ok()?;
    reply["model"].is_object().then(|| reply["model"]["webSearch"] == true)
}

/// Reads the three inputs through the host and decides. A host answer that cannot be read counts
/// as "not set up", never as available.
pub fn current<H: Host + ?Sized>(host: &H) -> Engine {
    if key_saved(host) {
        return Engine::Brave;
    }
    decide(false, native_enabled(host), chat_model(host))
}
