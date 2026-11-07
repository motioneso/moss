//! Durable metadata queue. Connection handles stay private to this crate.
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use moss_platform_contracts::{Actor, Error, Metadata, QueueSpec};
use serde_json::Value;
use std::{collections::BTreeMap, str::FromStr};
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls, Transaction};
use uuid::Uuid;

pub const MIGRATION: &str = include_str!("../sql/0001_queue.sql");
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Producer,
    Worker,
}
pub struct Queue {
    client: Mutex<Client>,
    specs: BTreeMap<String, QueueSpec>,
    role: Role,
}
pub struct ClaimedJob {
    pub id: Uuid,
    pub actor: Actor,
    pub metadata: Metadata,
    token: Uuid,
    lease_seconds: u32,
}
/// The safety core implements this by opening a DataContext for this actor and request id.
/// Handlers re-read content through that context. Errors carry only a fixed code.
#[async_trait]
pub trait JobHandler: Send + Sync {
    async fn execute_in_data_context(&self, actor: Actor, metadata: &Metadata)
        -> Result<(), Error>;
}
fn database(_: tokio_postgres::Error) -> Error {
    Error::Database
}
impl Queue {
    pub async fn connect(url: &str, role: Role, specs: Vec<QueueSpec>) -> Result<Self, Error> {
        let mut declared = BTreeMap::new();
        for spec in specs {
            spec.validate()?;
            if declared.insert(spec.name.clone(), spec).is_some() {
                return Err(Error::InvalidDeclaration);
            }
        }
        let (client, connection) = tokio_postgres::connect(url, NoTls)
            .await
            .map_err(database)?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let row=client.query_one("SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",&[]).await.map_err(database)?;
        let expected = match role {
            Role::Producer => "jarvis_app_runtime",
            Role::Worker => "jarvis_worker_runtime",
        };
        if row.get::<_, String>(0) != expected || row.get::<_, bool>(1) || row.get::<_, bool>(2) {
            return Err(Error::Database);
        }
        Ok(Self {
            client: Mutex::new(client),
            specs: declared,
            role,
        })
    }
    fn spec(&self, name: &str) -> Result<&QueueSpec, Error> {
        self.specs.get(name).ok_or(Error::InvalidDeclaration)
    }
    pub async fn enqueue(
        &self,
        actor: Actor,
        name: &str,
        payload: Value,
        key: Uuid,
        at: DateTime<Utc>,
    ) -> Result<Option<Uuid>, Error> {
        let spec = self.spec(name)?;
        let metadata = spec.parse_payload(payload)?;
        if metadata.actor_user_id() != actor.user_id() {
            return Err(Error::InvalidPayload);
        }
        let mut client = self.client.lock().await;
        let tx = client.transaction().await.map_err(database)?;
        scope(&tx, actor).await?;
        let id = insert(&tx, spec, &metadata, key, at).await?;
        tx.commit().await.map_err(database)?;
        Ok(id)
    }
    pub async fn claim(&self) -> Result<Option<ClaimedJob>, Error> {
        if self.role != Role::Worker {
            return Err(Error::Unavailable);
        }
        let mut client = self.client.lock().await;
        let tx = client.transaction().await.map_err(database)?;
        // Expired claims are fenced. Attempts count starts, so retryLimit is additional starts.
        let names: Vec<String> = self.specs.keys().cloned().collect();
        tx.execute("UPDATE moss_queue.jobs SET state=CASE WHEN attempts>retry_limit THEN 'failed' ELSE 'pending' END, run_at=clock_timestamp()+make_interval(secs=>least(86400, retry_delay_seconds * CASE WHEN retry_backoff THEN power(2,least(attempts-1,16)) ELSE 1 END)::integer), lease_token=NULL, lease_until=NULL, failure_code='lease-expired' WHERE state='running' AND lease_until<=clock_timestamp() AND queue=ANY($1)",&[&names]).await.map_err(database)?;
        let token = Uuid::new_v4();
        let row=tx.query_opt("WITH candidate AS (SELECT id FROM moss_queue.jobs WHERE state='pending' AND run_at<=clock_timestamp() AND queue=ANY($1) ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE moss_queue.jobs j SET state='running',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+make_interval(secs=>lease_seconds) FROM candidate c WHERE j.id=c.id RETURNING j.id,j.actor_user_id,j.queue,j.payload",&[&names,&token]).await.map_err(database)?;
        let Some(row) = row else {
            tx.commit().await.map_err(database)?;
            return Ok(None);
        };
        let id: Uuid = row.get(0);
        let actor_id: Uuid = row.get(1);
        let name: String = row.get(2);
        let parsed = self.spec(&name)?.parse_payload(row.get(3));
        let metadata = match parsed {
            Ok(p) if p.actor_user_id() == actor_id => p,
            _ => {
                tx.execute("UPDATE moss_queue.jobs SET state='failed',failure_code='invalid-payload',lease_token=NULL,lease_until=NULL WHERE id=$1",&[&id]).await.map_err(database)?;
                tx.commit().await.map_err(database)?;
                return Err(Error::InvalidPayload);
            }
        };
        tx.commit().await.map_err(database)?;
        Ok(Some(ClaimedJob {
            id,
            actor: Actor::from_authenticated_session(actor_id, Uuid::new_v4()),
            metadata,
            token,
            lease_seconds: self.spec(&name)?.lease_seconds,
        }))
    }
    pub async fn renew(&self, job: &ClaimedJob) -> Result<(), Error> {
        let count=self.client.lock().await.execute("UPDATE moss_queue.jobs SET lease_until=clock_timestamp()+make_interval(secs=>lease_seconds) WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()",&[&job.id,&job.token]).await.map_err(database)?;
        if count == 1 {
            Ok(())
        } else {
            Err(Error::StaleLease)
        }
    }
    pub async fn finish(&self, job: &ClaimedJob, success: bool) -> Result<(), Error> {
        let count=self.client.lock().await.execute("UPDATE moss_queue.jobs SET state=CASE WHEN $3 THEN 'completed' WHEN attempts>retry_limit THEN 'failed' ELSE 'pending' END, run_at=clock_timestamp()+make_interval(secs=>least(86400,retry_delay_seconds * CASE WHEN retry_backoff THEN power(2,least(attempts-1,16)) ELSE 1 END)::integer), failure_code=CASE WHEN $3 THEN NULL ELSE 'handler' END,lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()",&[&job.id,&job.token,&success]).await.map_err(database)?;
        if count == 1 {
            Ok(())
        } else {
            Err(Error::StaleLease)
        }
    }
    pub async fn run_one(&self, handler: &dyn JobHandler) -> Result<bool, Error> {
        let Some(job) = self.claim().await? else {
            return Ok(false);
        };
        let execution = handler.execute_in_data_context(job.actor, &job.metadata);
        tokio::pin!(execution);
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_millis(
            u64::from(job.lease_seconds) * 1000 / 3,
        ));
        heartbeat.tick().await;
        let result = loop {
            tokio::select! {
                result = &mut execution => break result,
                _ = heartbeat.tick() => self.renew(&job).await?,
            }
        };
        self.finish(&job, result.is_ok()).await?;
        Ok(true)
    }
    pub async fn schedule(
        &self,
        actor: Actor,
        id: Uuid,
        name: &str,
        payload: Value,
        expression: &str,
        timezone: &str,
        after: DateTime<Utc>,
    ) -> Result<(), Error> {
        let spec = self.spec(name)?;
        let metadata = spec.parse_payload(payload)?;
        if metadata.actor_user_id() != actor.user_id() {
            return Err(Error::InvalidPayload);
        }
        let at = next_occurrence(expression, timezone, after)?;
        let payload = serde_json::to_value(metadata).map_err(|_| Error::InvalidPayload)?;
        let mut client = self.client.lock().await;
        let tx = client.transaction().await.map_err(database)?;
        scope(&tx, actor).await?;
        tx.execute("INSERT INTO moss_queue.schedules(id,actor_user_id,queue,payload,cron,timezone,next_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET queue=excluded.queue,payload=excluded.payload,cron=excluded.cron,timezone=excluded.timezone,next_at=excluded.next_at,disabled_reason=NULL",&[&id,&actor.user_id(),&name,&payload,&expression,&timezone,&at]).await.map_err(database)?;
        tx.commit().await.map_err(database)?;
        Ok(())
    }
    pub async fn unschedule(&self, actor: Actor, id: Uuid) -> Result<bool, Error> {
        if self.role != Role::Producer {
            return Err(Error::Unavailable);
        }
        let mut client = self.client.lock().await;
        let tx = client.transaction().await.map_err(database)?;
        scope(&tx, actor).await?;
        let count = tx
            .execute("DELETE FROM moss_queue.schedules WHERE id=$1", &[&id])
            .await
            .map_err(database)?;
        tx.commit().await.map_err(database)?;
        Ok(count == 1)
    }
    /// Missed occurrences coalesce to one job. Invalid rows are quarantined independently.
    pub async fn tick(&self) -> Result<u64, Error> {
        if self.role != Role::Worker {
            return Err(Error::Unavailable);
        }
        let mut client = self.client.lock().await;
        let tx = client.transaction().await.map_err(database)?;
        let names: Vec<String> = self.specs.keys().cloned().collect();
        let now: DateTime<Utc> = tx
            .query_one("SELECT clock_timestamp()", &[])
            .await
            .map_err(database)?
            .get(0);
        let rows=tx.query("SELECT id,actor_user_id,queue,payload,cron,timezone,next_at FROM moss_queue.schedules WHERE disabled_reason IS NULL AND next_at<=$2 AND queue=ANY($1) ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 100",&[&names,&now]).await.map_err(database)?;
        let mut enqueued = 0;
        for row in &rows {
            let id: Uuid = row.get(0);
            let actor_id: Uuid = row.get(1);
            let name: String = row.get(2);
            let at: DateTime<Utc> = row.get(6);
            let spec = self.spec(&name)?;
            let payload = match spec.parse_payload(row.get(3)) {
                Ok(payload) if payload.actor_user_id() == actor_id => payload,
                _ => {
                    tx.execute("UPDATE moss_queue.schedules SET disabled_reason='invalid-payload' WHERE id=$1", &[&id]).await.map_err(database)?;
                    continue;
                }
            };
            let next = match next_occurrence(
                &row.get::<_, String>(4),
                &row.get::<_, String>(5),
                at.max(now),
            ) {
                Ok(next) => next,
                Err(_) => {
                    tx.execute("UPDATE moss_queue.schedules SET disabled_reason='invalid-schedule' WHERE id=$1", &[&id]).await.map_err(database)?;
                    continue;
                }
            };
            let key = Uuid::new_v5(&id, at.to_rfc3339().as_bytes());
            enqueued += u64::from(insert(&tx, spec, &payload, key, at).await?.is_some());
            tx.execute(
                "UPDATE moss_queue.schedules SET next_at=$2 WHERE id=$1",
                &[&id, &next],
            )
            .await
            .map_err(database)?;
        }
        tx.commit().await.map_err(database)?;
        Ok(enqueued)
    }
}
async fn scope(tx: &Transaction<'_>, actor: Actor) -> Result<(), Error> {
    tx.query_one(
        "SELECT set_config('app.actor_user_id',$1,true),set_config('app.request_id',$2,true)",
        &[
            &actor.user_id().to_string(),
            &actor.request_id().to_string(),
        ],
    )
    .await
    .map_err(database)?;
    Ok(())
}
async fn insert(
    tx: &Transaction<'_>,
    spec: &QueueSpec,
    payload: &Metadata,
    key: Uuid,
    at: DateTime<Utc>,
) -> Result<Option<Uuid>, Error> {
    let value = serde_json::to_value(payload).map_err(|_| Error::InvalidPayload)?;
    let id = Uuid::new_v4();
    let row=tx.query_opt("INSERT INTO moss_queue.jobs(id,actor_user_id,queue,idempotency_key,payload,run_at,retry_limit,retry_delay_seconds,retry_backoff,lease_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(actor_user_id,queue,idempotency_key) DO NOTHING RETURNING id",&[&id,&payload.actor_user_id(),&spec.name,&key,&value,&at,&(spec.retry_limit as i32),&(spec.retry_delay_seconds as i32),&spec.retry_backoff,&(spec.lease_seconds as i32)]).await.map_err(database)?;
    Ok(row.map(|r| r.get(0)))
}
pub fn next_occurrence(
    expression: &str,
    timezone: &str,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, Error> {
    if expression.split_whitespace().count() != 5 {
        return Err(Error::InvalidDeclaration);
    }
    let cron = cron::Schedule::from_str(&format!("0 {expression} *"))
        .map_err(|_| Error::InvalidDeclaration)?;
    let tz = chrono_tz::Tz::from_str(timezone).map_err(|_| Error::InvalidDeclaration)?;
    cron.after(&after.with_timezone(&tz))
        .next()
        .map(|at| at.with_timezone(&Utc))
        .ok_or(Error::InvalidDeclaration)
}
