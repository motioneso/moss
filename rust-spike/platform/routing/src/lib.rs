//! Features name a capability. Provider mechanics and credential use belong to adapters.
use async_trait::async_trait;
use moss_platform_contracts::{Actor, Error};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability { Chat, ToolUse, Json, Vision, Summarization, Transcription, WebSearch }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier { Economy, Interactive, Reasoning }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: Uuid,
    pub provider_id: Uuid,
    pub provider_model_id: String,
    pub capabilities: Vec<Capability>,
    pub tier: Tier,
    pub active: bool,
    pub provider_active: bool,
    pub assistant: bool,
    /// Adapter classification; e.g. choice-only transports cannot serve automatic prompts.
    pub automatic_eligible: bool,
    pub default_sentinel: bool,
    pub shared_transcription_eligible: bool,
    pub voice_endpoint: bool,
    #[serde(default)] pub allow_user_override: bool,
    pub released_at: Option<String>,
    pub created_at: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag="kind",rename_all="lowercase")]
pub enum Binding { Model { #[serde(rename="modelId")] model_id:Uuid }, Mode { tier:Tier } }
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Configuration {
    pub models: Vec<Model>,
    pub pinned_model: Option<Uuid>,
    pub pinned_provider: Option<Uuid>,
    pub default_provider: Option<Uuid>,
    pub chat_binding: Option<Binding>,
    pub transcription_binding: Option<Binding>,
    pub chat_override: Option<Uuid>,
    #[serde(default)] pub override_enabled: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Resolution { pub model:Option<Model>, pub reason:&'static str }
impl Resolution {
    fn new(model:Option<Model>,reason:&'static str)->Self { Self { model,reason } }
}
/// Join point: load inside the safety core's actor-scoped DataContext, never a global snapshot.
#[async_trait]
pub trait ConfigurationStore: Send + Sync {
    async fn for_actor(&self,actor:Actor)->Result<Configuration,Error>;
}
#[async_trait]
pub trait CapabilityTransport: Send + Sync {
    async fn generate(&self,actor:Actor,model:&Model,messages:&[Turn],max_output_tokens:u32)->Result<String,Error>;
}
#[derive(Serialize,Deserialize)]
pub struct Turn { pub role:TurnRole, pub content:String }
#[derive(Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum TurnRole { User, Assistant }
pub struct Router<S,T> { pub store:S, pub transport:T }
impl<S:ConfigurationStore,T:CapabilityTransport> Router<S,T> {
    pub async fn generate(&self,actor:Actor,capability:Capability,messages:&[Turn],max_output_tokens:u32)->Result<String,Error> {
        let config=self.store.for_actor(actor).await?;
        let mut selected=resolve(&config,capability,Tier::Interactive);
        if capability==Capability::Chat {
            if let Some(model)=user_override(&config) { selected=Resolution::new(Some(model),"user-override"); }
        }
        let model=selected.model.ok_or(Error::Unavailable)?;
        self.transport.generate(actor,&model,messages,max_output_tokens).await
    }
}
fn usable(m:&Model,cap:Capability)->bool { m.active && m.provider_active && m.capabilities.contains(&cap) }
fn exact(config:&Configuration,id:Uuid,cap:Capability)->Option<Model> { config.models.iter().find(|m|m.id==id && usable(m,cap) && m.assistant).cloned() }
fn rank(m:&Model)->(Option<&str>,&str,Uuid) { (m.released_at.as_deref(),&m.created_at,m.id) }
fn ladder(config:&Configuration,provider:Option<Uuid>,cap:Capability,tier:Tier)->Option<Model> {
    let mut candidates:Vec<&Model>=config.models.iter().filter(|m| usable(m,cap) && m.assistant && m.automatic_eligible && provider.is_none_or(|id|m.provider_id==id)).collect();
    candidates.sort_by(|a,b| {
        let sentinel=if provider.is_some() { b.default_sentinel.cmp(&a.default_sentinel) } else { std::cmp::Ordering::Equal };
        sentinel.then_with(||rank(b).cmp(&rank(a)))
    });
    let tiers:&[Tier]=match tier { Tier::Economy=>&[Tier::Economy,Tier::Interactive,Tier::Reasoning], Tier::Interactive=>&[Tier::Interactive,Tier::Reasoning],Tier::Reasoning=>&[Tier::Reasoning] };
    tiers.iter().find_map(|tier|candidates.iter().find(|m|m.tier==*tier).cloned()).or_else(||candidates.first().cloned()).cloned()
}
pub fn resolve(config:&Configuration,cap:Capability,tier:Tier)->Resolution {
    let pinned=config.pinned_model.is_some() || config.pinned_provider.is_some();
    if let Some(id)=config.pinned_model {
        if let Some(model)=exact(config,id,cap) { return Resolution::new(Some(model),"admin-pin"); }
        if cap==Capability::Chat { return Resolution::new(None,"admin-pin-unavailable"); }
        if let Some(provider)=config.models.iter().find(|m|m.id==id).map(|m|m.provider_id) {
            if let Some(model)=ladder(config,Some(provider),cap,tier) { return Resolution::new(Some(model),"admin-pin"); }
        }
    } else if let Some(provider)=config.pinned_provider {
        if let Some(model)=ladder(config,Some(provider),cap,tier) { return Resolution::new(Some(model),"admin-pin"); }
    }
    if pinned { return Resolution::new(None,if matches!(cap,Capability::Chat|Capability::Transcription) {"admin-pin-unavailable"} else {"needs-config"}); }
    if cap==Capability::Transcription {
        let model=match &config.transcription_binding {
            Some(Binding::Model {model_id})=>config.models.iter().find(|m|m.id==*model_id && usable(m,cap) && m.shared_transcription_eligible),
            Some(Binding::Mode {..})=>None,
            None=>config.models.iter().filter(|m|usable(m,cap) && m.voice_endpoint).max_by_key(|m|(&m.created_at,std::cmp::Reverse(m.id))),
        }.cloned();
        return Resolution::new(model.clone(),if model.is_some() {"manual-route"} else {"needs-config"});
    }
    if cap!=Capability::Chat {
        let model=ladder(config,None,cap,tier);
        return Resolution::new(model.clone(),if model.is_some() {"matched-active-model"} else {"no-active-model"});
    }
    if let Some(Binding::Model {model_id})=config.chat_binding {
        let model=exact(config,model_id,cap);
        return Resolution::new(model.clone(),if model.is_some() {"manual-route"} else {"needs-config"});
    }
    let chosen_tier=match config.chat_binding {Some(Binding::Mode {tier})=>tier,_=>tier};
    let model=config.default_provider.and_then(|provider|ladder(config,Some(provider),cap,chosen_tier));
    Resolution::new(model.clone(),if model.is_some() {"matched-active-model"} else {"needs-config"})
}
/// The existing lookup endpoint alone falls back to a selectable per-user chat override.
pub fn lookup(config:&Configuration,cap:Capability,tier:Tier)->Resolution {
    let resolved=resolve(config,cap,tier);
    if resolved.model.is_none() && cap==Capability::Chat {
        if let Some(model)=user_override(config) { return Resolution::new(Some(model),"user-override"); }
    }
    resolved
}

fn user_override(config:&Configuration)->Option<Model> {
    if !config.override_enabled || config.pinned_model.is_some() || config.pinned_provider.is_some() { return None; }
    config.chat_override.and_then(|id| exact(config,id,Capability::Chat)).filter(|m|m.allow_user_override)
}
