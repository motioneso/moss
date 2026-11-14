use crate::manifest::{Manifest, PORTS};
use access_context::AccessContext;
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use wasmtime::{
    component::{Component, Linker},
    Config, Engine, Store, StoreLimits, StoreLimitsBuilder,
};

#[derive(Clone, Debug)]
pub struct Limits {
    pub memory_bytes: usize,
    pub fuel: u64,
    /// Host-wide cap on a manifest's requested fuel. Never below `fuel`.
    pub fuel_ceiling: u64,
    pub deadline: Duration,
    pub message_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_bytes: 64 * 1024 * 1024,
            fuel: 10_000_000,
            fuel_ceiling: 10_000_000,
            deadline: Duration::from_secs(5),
            message_bytes: 1024 * 1024,
        }
    }
}
impl Limits {
    /// A manifest may raise its budget above the default, never above the host ceiling.
    pub fn effective_fuel(&self, requested: Option<u64>) -> u64 {
        requested.map_or(self.fuel, |r| r.clamp(self.fuel, self.fuel_ceiling))
    }
}
#[derive(Clone)]
pub struct CallScope {
    call_id: uuid::Uuid,
    access: AccessContext,
    module: Arc<Manifest>,
    deadline: Instant,
    kind: String,
}
impl CallScope {
    /// The handler kind that started this call: route, api, job, tool, event, install or health.
    pub fn kind(&self) -> &str {
        &self.kind
    }
    /// Unique to this guest invocation, including nested calls sharing a request ID.
    pub fn call_id(&self) -> uuid::Uuid {
        self.call_id
    }
    pub fn access(&self) -> &AccessContext {
        &self.access
    }
    pub fn module(&self) -> &Manifest {
        &self.module
    }
    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation: String,
    pub resource: String,
    #[serde(default)]
    pub parameters: Value,
}
/// Implementations are trusted host services, never guest code. They must use scope.access()
/// for DataContext/VaultContext and honor scope.remaining() for blocking I/O. No raw handles
/// are returned through this interface. Missing services fail closed.
pub trait Ports: Send + Sync {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value>;
    /// Opt-in finalization. Wrappers must forward this to their downstream services.
    /// A false result means guest failure, trap, or an unsuccessful route response.
    fn finish_call(&self, _scope: &CallScope, _success: bool) -> Result<()> {
        Ok(())
    }
}
struct Completion {
    scope: CallScope,
    ports: Arc<dyn Ports>,
    finished: bool,
}
impl Completion {
    fn finish(&mut self, success: bool) -> Result<()> {
        self.finished = true;
        self.ports.finish_call(&self.scope, success)
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        if !self.finished {
            // Preserve the original guest error. Trusted services must release their state
            // even when rollback itself fails; an error must never turn into a commit.
            let _ = self.ports.finish_call(&self.scope, false);
        }
    }
}
pub struct DenyPorts;
impl Ports for DenyPorts {
    fn invoke(&self, _: &CallScope, _: &str, _: &Request) -> Result<Value> {
        bail!("This host service is not connected")
    }
}
struct State {
    scope: CallScope,
    ports: Arc<dyn Ports>,
    limits: StoreLimits,
    message_bytes: usize,
}
pub struct Host {
    engine: Engine,
    limits: Limits,
    _clock: Arc<()>,
    compiled: Mutex<std::collections::BTreeMap<String, Component>>,
    disk: Option<crate::compiled::Compiled>,
}
impl Host {
    pub fn new(limits: Limits) -> Result<Self> {
        ensure!(
            limits.fuel > 0
                && limits.fuel_ceiling >= limits.fuel
                && limits.memory_bytes > 0
                && !limits.deadline.is_zero(),
            "Host limits must be positive"
        );
        let mut config = Config::new();
        config
            .wasm_component_model(true)
            .consume_fuel(true)
            .epoch_interruption(true);
        let engine = Engine::new(&config)?;
        let clock = Arc::new(());
        let weak = Arc::downgrade(&clock);
        let tick_engine = engine.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(10));
            if weak.upgrade().is_none() {
                break;
            }
            tick_engine.increment_epoch();
        });
        Ok(Self {
            engine,
            limits,
            _clock: clock,
            compiled: Mutex::new(Default::default()),
            disk: None,
        })
    }
    pub fn cached(
        limits: Limits,
        path: &std::path::Path,
        key: safety_core::secret::Secret,
    ) -> Result<Self> {
        let mut host = Self::new(limits)?;
        host.disk = Some(crate::compiled::Compiled::new(path, key, &host.engine)?);
        Ok(host)
    }
    fn compile(&self, wasm: &[u8]) -> Result<Component> {
        let key = crate::trust::digest(wasm);
        if let Some(component) = self
            .compiled
            .lock()
            .map_err(|_| anyhow::anyhow!("Compiled cache is busy"))?
            .get(&key)
            .cloned()
        {
            return Ok(component);
        }
        // Compilation and disk access do not hold the process-wide cache mutex.
        let component = match self
            .disk
            .as_ref()
            .and_then(|cache| cache.load(&self.engine, &key))
        {
            Some(component) => component,
            None => {
                let component = Component::new(&self.engine, wasm)
                    .context("The module is not a supported WebAssembly component")?;
                if let Some(cache) = &self.disk {
                    let _ = cache.save(&key, &component);
                }
                component
            }
        };
        let mut cache = self
            .compiled
            .lock()
            .map_err(|_| anyhow::anyhow!("Compiled cache is busy"))?;
        if cache.len() >= 32 {
            cache.clear();
        }
        cache.insert(key, component.clone());
        Ok(component)
    }
    pub fn validate(&self, wasm: &[u8], manifest: &Manifest) -> Result<()> {
        let component = self.compile(wasm)?;
        for (name, _) in component.component_type().imports(&self.engine) {
            let port = name
                .strip_prefix("moss:module/")
                .and_then(|s| s.strip_suffix("@1.0.0"));
            ensure!(
                port.is_some_and(|p| PORTS.contains(&p) && manifest.capability(p).is_ok()),
                "The module imports an undeclared or forbidden host service: {name}"
            );
        }
        Ok(())
    }
    pub fn call(
        &self,
        wasm: &[u8],
        manifest: Arc<Manifest>,
        access: AccessContext,
        ports: Arc<dyn Ports>,
        kind: &str,
        payload: &str,
    ) -> Result<String> {
        ensure!(
            matches!(
                kind,
                "route" | "api" | "job" | "tool" | "event" | "install" | "health"
            ),
            "Unknown module handler"
        );
        ensure!(
            payload.len() <= self.limits.message_bytes,
            "The module request is too large"
        );
        self.validate(wasm, &manifest)?;
        let component = self.compile(wasm)?;
        let mut linker = Linker::<State>::new(&self.engine);
        // No WASI linker, inherited environment, sockets, files, clocks or random device.
        for capability in &manifest.capabilities {
            let port = capability.port.clone();
            let name = format!("moss:module/{port}@1.0.0");
            linker.instance(&name)?.func_wrap(
                "call",
                move |state: wasmtime::StoreContextMut<'_, State>, (body,): (String,)| {
                    let result = (|| -> Result<String> {
                        let state = state.data();
                        ensure!(
                            body.len() <= state.message_bytes,
                            "The port request is too large"
                        );
                        ensure!(
                            !state.scope.remaining().is_zero(),
                            "The module call timed out"
                        );
                        let request: Request = serde_json::from_str(&body)?;
                        authorize(&state.scope.module, &port, &request)?;
                        let output = state.ports.invoke(&state.scope, &port, &request)?;
                        let output = serde_json::to_string(&output)?;
                        ensure!(
                            output.len() <= state.message_bytes,
                            "The port response is too large"
                        );
                        Ok(output)
                    })();
                    // Backend errors can contain credentials or private provider replies.
                    Ok((result.map_err(|_| "The host refused this module request".to_string()),))
                },
            )?;
        }
        let fuel = self.limits.effective_fuel(manifest.fuel_limit);
        let scope = CallScope {
            call_id: uuid::Uuid::new_v4(),
            access,
            module: manifest,
            deadline: Instant::now() + self.limits.deadline,
            kind: kind.to_owned(),
        };
        let mut completion = Completion {
            scope: scope.clone(),
            ports: ports.clone(),
            finished: false,
        };
        let mut store = Store::new(
            &self.engine,
            State {
                scope,
                ports,
                limits: StoreLimitsBuilder::new()
                    .memory_size(self.limits.memory_bytes)
                    .instances(16)
                    .memories(1)
                    .tables(8)
                    .table_elements(10_000)
                    .build(),
                message_bytes: self.limits.message_bytes,
            },
        );
        store.limiter(|state| &mut state.limits);
        store.set_fuel(fuel)?;
        store.set_epoch_deadline((self.limits.deadline.as_millis().div_ceil(10) as u64) + 1);
        let instance = linker.instantiate(&mut store, &component)?;
        let handle = instance
            .get_typed_func::<(String, String), (std::result::Result<String, String>,)>(
                &mut store, "handle",
            )?;
        let (response,) = handle.call(&mut store, (kind.into(), payload.into()))?;
        handle.post_return(&mut store)?;
        let response =
            response.map_err(|_| anyhow::anyhow!("The module could not finish this request"))?;
        ensure!(
            response.len() <= self.limits.message_bytes,
            "The module response is too large"
        );
        let success = kind != "route"
            || serde_json::from_str::<Value>(&response)
                .ok()
                .and_then(|v| v.get("status").and_then(Value::as_u64))
                .is_none_or(|status| status < 400);
        completion.finish(success)?;
        Ok(response)
    }
}
/// The guest may select an owned resource; it can never select an actor, role or connection.
pub fn authorize(manifest: &Manifest, port: &str, request: &Request) -> Result<()> {
    let cap = manifest.capability(port)?;
    ensure!(
        cap.operations.contains(&request.operation),
        "This operation was not approved"
    );
    ensure!(
        cap.resources.contains(&request.resource)
            || (port == "attachments" && cap.resources.contains("handed")),
        "This resource was not approved"
    );
    reject_context(&request.parameters)?;
    match port {
        "attachments" => ensure!(
            request.operation == "read" && uuid::Uuid::parse_str(&request.resource).is_ok(),
            "Only handed attachment IDs can be read"
        ),
        "db" => {
            ensure!(
                manifest.database.owned_tables.contains(&request.resource),
                "A module cannot query another module's table"
            );
            if request.operation == "query" {
                return crate::typed_query::validate(request.parameters.clone());
            }
            ensure!(
                matches!(
                    request.operation.as_str(),
                    "select" | "insert" | "update" | "delete"
                ),
                "Database requests must use typed operations"
            );
            ensure!(
                request.parameters.is_object(),
                "Database parameters must be an object"
            );
            ensure!(
                request
                    .parameters
                    .as_object()
                    .unwrap()
                    .keys()
                    .all(|k| matches!(k.as_str(), "id" | "values" | "limit")),
                "Raw SQL is not a database port operation"
            );
        }
        "vault" => ensure!(
            crate::manifest::relative_path(&request.resource),
            "The file name is unsafe"
        ),
        "fetch" if request.resource == crate::public_web::PUBLIC_WEB => ensure!(
            request.parameters.get("url").is_some_and(Value::is_string),
            "The request needs a URL"
        ),
        "browser" => ensure!(
            request.resource == crate::public_web::PUBLIC_WEB
                && request.parameters.get("url").is_some_and(Value::is_string),
            "The browser opens public pages only"
        ),
        "fetch" | "credentials" => {
            let url = request
                .parameters
                .get("url")
                .and_then(Value::as_str)
                .context("The request needs a URL")?;
            let url = url::Url::parse(url)?;
            ensure!(
                url.scheme() == "https"
                    && url.host_str() == Some(&request.resource)
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.port_or_known_default() == Some(443),
                "The destination was not approved"
            );
            if port == "credentials" {
                let name = request.parameters["credential"]
                    .as_str()
                    .context("A credential name is required")?;
                ensure!(
                    manifest
                        .credentials
                        .get(name)
                        .is_some_and(|c| c.hosts.contains(&request.resource)),
                    "The credential is bound to another service"
                );
                ensure!(
                    request.operation == "request" || request.operation == "exchange",
                    "Credential values are never a port result"
                );
            }
        }
        "jobs" if request.operation == "cancel" || request.operation == "unschedule" => {
            ensure!(
                request.parameters.as_object().is_some_and(|p| p.len() == 1)
                    && request.parameters["id"]
                        .as_str()
                        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok()),
                "Cancellation requires only a job id"
            );
            ensure!(
                manifest.jobs.contains_key(&request.resource),
                "Unknown module queue"
            );
        }
        "jobs"
            if matches!(
                request.operation.as_str(),
                "read" | "list-open" | "read-schedule"
            ) =>
        {
            // Read-only views of the caller's own queue rows. Each takes a fixed parameter shape.
            let params = request
                .parameters
                .as_object()
                .context("Job read parameters required")?;
            let valid = match request.operation.as_str() {
                "read" => {
                    params.len() == 1
                        && ["id", "idempotencyKey"].iter().any(|k| {
                            params
                                .get(*k)
                                .and_then(Value::as_str)
                                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                        })
                }
                "list-open" => params.is_empty(),
                _ => {
                    params.len() == 1
                        && params
                            .get("key")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
                }
            };
            ensure!(valid, "The job read parameters are not valid");
            ensure!(
                manifest.jobs.contains_key(&request.resource),
                "Unknown module queue"
            );
        }
        "jobs" => {
            ensure!(
                matches!(
                    request.operation.as_str(),
                    "enqueue" | "enqueue-options" | "enqueue-after-commit" | "schedule"
                ),
                "Unknown job operation"
            );
            if matches!(
                request.operation.as_str(),
                "enqueue-options" | "enqueue-after-commit"
            ) {
                let options = crate::enqueue_options::parse(&request.parameters)?;
                return validate_job_parameters(manifest, &request.resource, &options.params);
            }
            let parameters = if request.operation == "schedule" {
                let p = request
                    .parameters
                    .as_object()
                    .context("Schedule parameters required")?;
                ensure!(
                    p.len() == 3 + usize::from(p.contains_key("key")) + usize::from(p.contains_key("keepExisting"))
                        && p.get("keepExisting").is_none_or(Value::is_boolean)
                        && p.get("key").is_none_or(|k| {
                            k.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128)
                        })
                        && p.get("cron")
                            .and_then(Value::as_str)
                            .is_some_and(|s| s.len() <= 128)
                        && p.get("timezone")
                            .and_then(Value::as_str)
                            .is_some_and(|s| s.len() <= 128),
                    "Schedule requires only cron, timezone, params, an optional key and an optional keepExisting flag"
                );
                &request.parameters["params"]
            } else {
                &request.parameters
            };
            validate_job_parameters(manifest, &request.resource, parameters)?;
        }
        "api" => ensure!(
            manifest.requires.contains_key(&request.resource)
                || manifest.optional_requires.contains_key(&request.resource),
            "The module did not declare this public API dependency"
        ),
        "events" if request.operation == "publish" => ensure!(
            manifest.provides.contains_key(&request.resource),
            "The event is not declared"
        ),
        "tools" => {
            let tool = manifest
                .tools
                .get(&request.resource)
                .context("Tool not declared")?;
            ensure!(
                request
                    .parameters
                    .get("risk")
                    .is_none_or(|risk| risk.as_str() == Some(&tool.risk)),
                "Tool risk cannot change at call time"
            );
        }
        "ai" | "embed" | "transcribe" => ensure!(
            request.parameters.get("model").is_none()
                && request.parameters.get("provider").is_none(),
            "The host chooses the AI model"
        ),
        _ => (),
    }
    Ok(())
}
fn reject_context(value: &Value) -> Result<()> {
    match value {
        Value::Object(fields) => {
            for (name, v) in fields {
                ensure!(
                    !matches!(
                        name.as_str(),
                        "actor" | "actorUserId" | "role" | "connection" | "databaseUrl" | "sql"
                    ),
                    "The host owns the call identity and database connection"
                );
                reject_context(v)?;
            }
        }
        Value::Array(values) => {
            for v in values {
                reject_context(v)?;
            }
        }
        _ => (),
    }
    Ok(())
}

/// Existing work may come from enqueue or a schedule; this never authorizes a new enqueue.
pub(crate) fn authorize_job(manifest: &Manifest, resource: &str, parameters: &Value) -> Result<()> {
    let capability = manifest.capability("jobs")?;
    ensure!(
        capability.operations.contains("enqueue")
            || capability.operations.contains("enqueue-options")
            || capability.operations.contains("schedule"),
        "Creating work on this queue was not approved"
    );
    ensure!(
        capability.resources.contains(resource),
        "This resource was not approved"
    );
    reject_context(parameters)?;
    validate_job_parameters(manifest, resource, parameters)
}
fn validate_job_parameters(manifest: &Manifest, resource: &str, parameters: &Value) -> Result<()> {
    let schema = manifest
        .jobs
        .get(resource)
        .context("The module does not own this queue")?;
    let params = parameters
        .as_object()
        .context("Job parameters must be an object")?;
    ensure!(
        schema.len() == params.len(),
        "The job parameters do not match their schema"
    );
    for (name, kind) in schema {
        use crate::manifest::ParameterKind;
        let value = params.get(name).context("A job parameter is missing")?;
        ensure!(
            match kind {
                ParameterKind::Id => value
                    .as_str()
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok()),
                ParameterKind::Flag => value.is_boolean(),
                ParameterKind::Count => value.as_u64().is_some_and(|v| v <= 1_000_000),
                ParameterKind::Choice(choices) =>
                    value.as_str().is_some_and(|v| choices.contains(v)),
            },
            "A job parameter is not metadata of the declared kind"
        );
    }
    Ok(())
}
