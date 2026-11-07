//! HTTP protocol adapters. Credentials have no Debug/Display/Serialize implementation.
use async_trait::async_trait;
use moss_platform_contracts::{Actor,Error};
use moss_platform_routing::{CapabilityTransport,Model,Turn};
use reqwest::{Client,Url,header::{HeaderMap,HeaderValue,AUTHORIZATION}};
use serde::{Serialize,Deserialize};
use serde_json::{json,Value};
use std::time::Duration;
use zeroize::Zeroizing;
use uuid::Uuid;

pub struct Secret(Zeroizing<String>);
impl Secret { pub fn from_cipher_plaintext(value:String)->Self {Self(Zeroizing::new(value))} }
#[derive(Clone,Copy,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum Protocol { OpenaiCompatible, Anthropic, Google, Ollama }
pub struct Endpoint { pub protocol:Protocol, pub base_url:String, pub credential:Secret }
/// Implement with the safety core's cipher and actor-scoped provider lookup.
#[async_trait]
pub trait EndpointStore:Send+Sync { async fn for_model(&self,actor:Actor,provider:Uuid)->Result<Endpoint,Error>; }
pub struct HttpAdapters<S> { store:S, client:Client }
impl<S:EndpointStore> HttpAdapters<S> {
    pub fn new(store:S)->Result<Self,Error> {
        let client=Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120)).connect_timeout(Duration::from_secs(10)).build().map_err(|_|Error::Transport)?;
        Ok(Self { store,client })
    }
}
struct Request { url:Url, headers:HeaderMap, body:Value }
fn request(endpoint:&Endpoint,model:&str,messages:&[Turn],max:u32)->Result<Request,Error> {
    if max==0 || max>1_000_000 || messages.len()>1024 { return Err(Error::InvalidPayload); }
    let normalized=endpoint.base_url.trim().trim_end_matches('/').trim_end_matches("/v1").trim_end_matches('/');
    let normalized=if normalized.is_empty() {match endpoint.protocol {Protocol::Anthropic=>"https://api.anthropic.com",Protocol::OpenaiCompatible=>"https://api.openai.com",Protocol::Google=>"https://generativelanguage.googleapis.com",_=>return Err(Error::InvalidDeclaration)}} else {normalized};
    let base=Url::parse(normalized).map_err(|_|Error::InvalidDeclaration)?;
    if !matches!(base.scheme(),"http"|"https") || !base.username().is_empty() || base.password().is_some() || base.query().is_some() || base.fragment().is_some() {return Err(Error::InvalidDeclaration);}
    let mut headers=HeaderMap::new();
    let mut set_secret=|name:&'static str,value:String|->Result<(),Error> { let mut value=HeaderValue::from_str(&value).map_err(|_|Error::Transport)?; value.set_sensitive(true);headers.insert(name,value);Ok(()) };
    let key=endpoint.credential.0.as_str();
    let (path,body)=match endpoint.protocol {
        Protocol::OpenaiCompatible=> {set_secret(AUTHORIZATION.as_str(),format!("Bearer {key}"))?;("v1/chat/completions".to_owned(),json!({"model":model,"messages":messages,"max_tokens":max}))},
        Protocol::Anthropic=> {set_secret("x-api-key",key.to_owned())?;headers.insert("anthropic-version",HeaderValue::from_static("2023-06-01"));("v1/messages".to_owned(),json!({"model":model,"max_tokens":max,"messages":messages}))},
        Protocol::Google=> {set_secret("x-goog-api-key",key.to_owned())?;let mut path=base.clone();path.path_segments_mut().map_err(|_|Error::InvalidDeclaration)?.pop_if_empty().push("v1beta").push("models").push(&format!("{model}:generateContent"));let contents:Vec<_>=messages.iter().map(|m|json!({"role":match m.role {moss_platform_routing::TurnRole::Assistant=>"model",_=>"user"},"parts":[{"text":m.content}]})).collect();return Ok(Request {url:path,headers,body:json!({"contents":contents,"generationConfig":{"maxOutputTokens":max}})});},
        Protocol::Ollama=> {if !key.is_empty() {set_secret(AUTHORIZATION.as_str(),format!("Bearer {key}"))?;} ("api/chat".to_owned(),json!({"model":model,"messages":messages,"stream":false,"options":{"num_predict":max}}))},
    };
    let url=Url::parse(&format!("{}/{path}",normalized)).map_err(|_|Error::InvalidDeclaration)?;
    Ok(Request {url,headers,body})
}
fn extract(protocol:Protocol,value:&Value)->Result<String,Error> {
    let text=match protocol {
        Protocol::OpenaiCompatible=>value.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_owned),
        Protocol::Anthropic=>value.get("content").and_then(Value::as_array).map(|a|a.iter().filter(|v|v["type"]=="text").filter_map(|v|v["text"].as_str()).collect::<String>()),
        Protocol::Google=>value.pointer("/candidates/0/content/parts/0/text").and_then(Value::as_str).map(str::to_owned),
        Protocol::Ollama=>value.pointer("/message/content").and_then(Value::as_str).map(str::to_owned),
    };
    text.filter(|s|!s.is_empty()).ok_or(Error::Transport)
}
#[async_trait]
impl<S:EndpointStore> CapabilityTransport for HttpAdapters<S> {
    async fn generate(&self,actor:Actor,model:&Model,messages:&[Turn],max:u32)->Result<String,Error> {
        let endpoint=self.store.for_model(actor,model.provider_id).await?;
        let request=request(&endpoint,&model.provider_model_id,messages,max)?;
        let mut response=self.client.post(request.url).headers(request.headers).json(&request.body).send().await.map_err(|_|Error::Transport)?;
        if !response.status().is_success() {return Err(Error::Transport);}
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(|_|Error::Transport)? {if bytes.len()+chunk.len()>4*1024*1024 {return Err(Error::Transport);} bytes.extend_from_slice(&chunk);}
        let value:Value=serde_json::from_slice(&bytes).map_err(|_|Error::Transport)?;
        extract(endpoint.protocol,&value)
    }
}
