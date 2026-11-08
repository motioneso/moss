//! Phase 2b queue adapter. Guests supply typed parameters, never an actor or payload envelope.
use crate::{
    manifest::{Manifest, ParameterKind},
    runtime::{CallScope, Ports, Request},
    store::Installer,
};
use anyhow::{ensure, Context, Result};
use moss_platform_contracts::{Actor, ParamSchema, QueueSpec};
use moss_platform_jobs::{Queue, Role};
use safety_core::{
    db::{DataContext, Database},
    secret::Secret,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::runtime::Runtime;
pub const MIGRATION: &str = include_str!("../sql/0003_queue_join.sql");
pub fn module_key(id: &str) -> String {
    format!("m-{}", &crate::trust::digest(id.as_bytes())[..32])
}
pub fn manifest_hash(manifest: &Manifest) -> String {
    let mut value = serde_json::to_value(manifest).expect("manifest");
    // PostgreSQL jsonb normalizes object order, while serde_json may preserve insertion
    // order through a transitive feature. Identity must survive both representations.
    value.sort_all_objects();
    format!(
        "sha256:{}",
        crate::trust::digest(&serde_json::to_vec(&value).expect("manifest"))
    )
}
pub fn specs(manifest: &Manifest) -> Vec<QueueSpec> {
    let module = module_key(&manifest.id);
    manifest
        .jobs
        .iter()
        .map(|(name, fields)| {
            let queue = format!("{module}.{name}");
            QueueSpec {
                name: queue.clone(),
                module_id: module.clone(),
                job_kinds: vec![queue],
                params_schema: Some(ParamSchema::Object {
                    fields: fields
                        .iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                match v {
                                    ParameterKind::Id => ParamSchema::Uuid,
                                    ParameterKind::Flag => ParamSchema::Boolean,
                                    ParameterKind::Count => ParamSchema::Integer {
                                        min: 0,
                                        max: 1_000_000,
                                    },
                                    ParameterKind::Choice(choices) => ParamSchema::Enum {
                                        values: choices.iter().cloned().collect(),
                                    },
                                },
                            )
                        })
                        .collect(),
                }),
                retry_limit: 3,
                retry_delay_seconds: 10,
                retry_backoff: true,
                lease_seconds: 60,
            }
        })
        .collect()
}
fn actor(scope: &CallScope) -> Actor {
    Actor::from_authenticated_session(scope.access().actor_user_id(), uuid::Uuid::new_v4())
}
pub struct JobPorts {
    runtime: Runtime,
    producer: Secret,
    app: Database,
    next: Arc<dyn Ports>,
}
impl JobPorts {
    pub fn new(producer: Secret, app: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            runtime: Runtime::new()?,
            producer,
            app,
            next,
        })
    }
}
impl Ports for JobPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "jobs" {
            return self.next.invoke(scope, port, request);
        }
        // Ports may also be called by trusted native modules: enforce the same boundary here.
        crate::runtime::authorize(scope.module(), port, request)?;
        let spec = specs(scope.module())
            .into_iter()
            .find(|s| s.name == format!("{}.{}", module_key(&scope.module().id), request.resource))
            .context("Unknown queue")?;
        self.runtime.block_on(async {
            match request.operation.as_str() {
                "enqueue"=> {
                    let queue=Queue::connect(self.producer.expose_secret(),Role::Producer,vec![spec.clone()]).await?;
                    let payload=json!({"actorUserId":scope.access().actor_user_id(),"moduleId":module_key(&scope.module().id),"manifestHash":manifest_hash(scope.module()),"jobKind":spec.name,"params":request.parameters});
                    let id=queue.enqueue(actor(scope),&spec.name,payload,uuid::Uuid::new_v4(),chrono::Utc::now()).await?;
                    Ok(json!({"id":id}))
                }
                "enqueue-options" => {
                    let options = crate::enqueue_options::parse(&request.parameters)?;
                    let queue = Queue::connect(
                        self.producer.expose_secret(), Role::Producer, vec![spec.clone()],
                    ).await?;
                    let payload = json!({
                        "actorUserId": scope.access().actor_user_id(),
                        "moduleId": module_key(&scope.module().id),
                        "manifestHash": manifest_hash(scope.module()),
                        "jobKind": spec.name,
                        "params": options.params,
                    });
                    let id = queue.enqueue(
                        actor(scope), &spec.name, payload,
                        options.idempotency_key, options.available_at,
                    ).await?;
                    Ok(json!({"id": id}))
                }
                "schedule"=> {
                    let queue=Queue::connect(self.producer.expose_secret(),Role::Producer,vec![spec.clone()]).await?;
                    let payload=json!({"actorUserId":scope.access().actor_user_id(),"moduleId":module_key(&scope.module().id),"manifestHash":manifest_hash(scope.module()),"jobKind":spec.name,"params":request.parameters["params"]});
                    let id=uuid::Uuid::new_v4();
                    queue.schedule(actor(scope),id,&spec.name,payload,request.parameters["cron"].as_str().context("Cron required")?,request.parameters["timezone"].as_str().context("Timezone required")?,chrono::Utc::now()).await?;
                    Ok(json!({"id":id}))
                }
                "unschedule"=> {
                    let id:uuid::Uuid=request.parameters["id"].as_str().context("Schedule id required")?.parse()?;
                    let cx=DataContext::open(&self.app,scope.access()).await.map_err(|_|anyhow::anyhow!("Cannot open the schedule context"))?;
                    let changed=cx.db().execute("DELETE FROM moss_queue.schedules WHERE id=$1 AND queue=$2",&[&id,&spec.name]).await?;
                    cx.commit().await.map_err(|_|anyhow::anyhow!("Cannot commit schedule cancellation"))?;
                    Ok(json!({"cancelled":changed==1}))
                }
                "cancel"=> {
                    let id:uuid::Uuid=request.parameters["id"].as_str().context("Job id required")?.parse()?;
                    let cx=DataContext::open(&self.app,scope.access()).await.map_err(|_|anyhow::anyhow!("Cannot open the job context"))?;
                    let changed=cx.db().execute("UPDATE moss_queue.jobs SET state='failed',lease_token=NULL,lease_until=NULL WHERE id=$1 AND queue=$2 AND state='pending'",&[&id,&spec.name]).await?;
                    cx.commit().await.map_err(|_|anyhow::anyhow!("Cannot commit cancellation"))?;
                    Ok(json!({"cancelled":changed==1}))
                }
                _=>anyhow::bail!("Unknown job operation"),
            }
        })
    }
}
impl Installer {
    /// Run on a bounded blocking executor. The read fence covers claim through completion,
    /// so an upgrade waits for this invocation, including its Phase 2b lease update.
    pub fn run_job(&self, worker: &Secret) -> Result<bool> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        ensure!(
            !self.root.path().join("operation.json").exists(),
            "Recovery is pending"
        );
        let state = self.catalog.load()?;
        let declarations: Vec<_> = state
            .installed
            .values()
            .filter(|m| m.disabled.is_none())
            .flat_map(|m| specs(&m.manifest))
            .collect();
        let runtime = Runtime::new()?;
        let queue = runtime.block_on(Queue::connect(
            worker.expose_secret(),
            Role::Worker,
            declarations,
        ))?;
        let Some(job) = runtime.block_on(queue.claim())? else {
            return Ok(false);
        };
        let envelope = serde_json::to_value(&job.metadata)?;
        let module = state
            .installed
            .values()
            .find(|m| module_key(&m.manifest.id) == envelope["moduleId"].as_str().unwrap_or(""))
            .context("The job's module is not active")?;
        let result = (|| {
            ensure!(
                envelope["manifestHash"] == manifest_hash(&module.manifest),
                "The queued module version changed"
            );
            let params = job.metadata.params().cloned().unwrap_or_else(|| json!({}));
            let local = job
                .metadata
                .job_kind()
                .strip_prefix(&format!("{}.", module_key(&module.manifest.id)))
                .context("Unknown module queue")?;
            crate::runtime::authorize_job(&module.manifest, local, &params)?;
            self.call_unfenced(
                &module.manifest.id,
                access_context::AccessContext::new(
                    job.actor.user_id(),
                    job.actor.request_id().to_string(),
                ),
                "job",
                &json!({"queue":local,"parameters":params}).to_string(),
            )
            .map(|_| ())
        })();
        runtime.block_on(queue.finish(&job, result.is_ok()))?;
        result?;
        Ok(true)
    }
}

/// Rebind only parameters which still pass the new manifest. Removed or incompatible work
/// ends explicitly; it is never silently run against a different schema.
pub(crate) async fn reconcile(
    db: &tokio_postgres::Client,
    id: &str,
    installed: Option<&crate::store::Installed>,
) -> Result<()> {
    let key = module_key(id);
    for (table, pending) in [
        ("moss_queue.jobs", "state='pending'"),
        ("moss_queue.schedules", "disabled_reason IS NULL"),
    ] {
        for row in db
            .query(
                &format!(
                    "SELECT id,payload FROM {table} WHERE payload->>'moduleId'=$1 AND {pending}"
                ),
                &[&key],
            )
            .await?
        {
            let id: uuid::Uuid = row.get(0);
            let mut payload: Value = row.get(1);
            let valid = installed.filter(|m| m.disabled.is_none()).is_some_and(|m| {
                let local = payload["jobKind"]
                    .as_str()
                    .and_then(|s| s.strip_prefix(&format!("{key}.")))
                    .unwrap_or("");
                crate::runtime::authorize_job(&m.manifest, local, &payload["params"]).is_ok()
            });
            if valid {
                payload["manifestHash"] =
                    json!(manifest_hash(&installed.expect("active").manifest));
                db.execute(
                    &format!("UPDATE {table} SET payload=$2 WHERE id=$1"),
                    &[&id, &payload],
                )
                .await?;
            } else if table == "moss_queue.jobs" {
                db.execute("UPDATE moss_queue.jobs SET state='failed',failure_code='invalid-payload' WHERE id=$1",&[&id]).await?;
            } else {
                db.execute(
                    "UPDATE moss_queue.schedules SET disabled_reason='invalid-payload' WHERE id=$1",
                    &[&id],
                )
                .await?;
            }
        }
    }
    Ok(())
}
