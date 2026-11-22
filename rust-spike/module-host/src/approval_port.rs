//! The `approvals` port. A module proposes a durable, owner-scoped approval now and the
//! account confirms it later over HTTP, so the record must outlive the turn that created it.
//! The surface ports the TypeScript `DayPlanChangeApprovalPort` over the audited
//! assistant-action store: create a pending record, read one by id, flip pending to confirmed
//! exactly once, and find the pending or confirmed record for an operation.
//!
//! The host decides who the record belongs to and which module and permission resource it was
//! created under: the owner always comes from the call's access context, the module from the
//! calling module, and the resource from the manifest capability. No request field can name a
//! user or module, and the database applies the same owner through row-level security with no
//! admin bypass. Records hold metadata and the input summary the module binds to the approval
//! (actor, plan, operation, revision and the ordered change set for the day-plan flow);
//! secrets never enter this port.
use crate::runtime::{CallScope, Request};
use access_context::AccessContext;
use anyhow::{bail, ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::runtime::Runtime;

/// The migration that creates the store. Applied by module installation, safe to repeat.
pub const MIGRATION: &str = include_str!("../sql/0005_module_approvals.sql");

/// Operations a module may declare for this port.
pub const OPERATIONS: &[&str] = &["create", "get", "confirm", "find-pending", "find-confirmed"];

const SUMMARY_LIMIT: usize = 256 * 1024;
const OPERATION_ID_LIMIT: usize = 100;

/// One stored approval. The port's reply shape is the TypeScript approval record:
/// identity, owner, state and the stored input summary. Never a secret; only what the
/// module itself bound to the approval.
pub struct Record {
    pub id: String,
    pub owner_user_id: String,
    pub status: String,
    pub input_summary: Value,
}

impl Record {
    fn reply(&self) -> Value {
        json!({
            "id": self.id,
            "ownerUserId": self.owner_user_id,
            "status": self.status,
            "inputSummary": self.input_summary,
        })
    }
}

/// The store behind the port. Every method runs as the given account.
pub trait Approvals: Send + Sync {
    /// Writes one pending record and returns it. The owner is the caller.
    fn create(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        input_summary: &Value,
    ) -> Result<Record>;
    /// Reads one of this module's records for the caller. Not found for anyone else's.
    fn get(&self, access: &AccessContext, module: &str, resource: &str, id: &str)
        -> Result<Record>;
    /// Resolves pending to confirmed atomically. Refused when the record is not pending, so
    /// a replayed confirm can never execute twice.
    fn confirm(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        id: &str,
    ) -> Result<Record>;
    /// The newest record of this module for one operation in the requested state.
    fn find(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        status: &str,
        operation_id: &str,
    ) -> Result<Option<Record>>;
}

/// Refuses every call. The default until the shell supplies a store.
pub struct NoApprovals;
impl Approvals for NoApprovals {
    fn create(&self, _: &AccessContext, _: &str, _: &str, _: &Value) -> Result<Record> {
        bail!("Approvals are not available on this install")
    }
    fn get(&self, _: &AccessContext, _: &str, _: &str, _: &str) -> Result<Record> {
        bail!("Approvals are not available on this install")
    }
    fn confirm(&self, _: &AccessContext, _: &str, _: &str, _: &str) -> Result<Record> {
        bail!("Approvals are not available on this install")
    }
    fn find(
        &self,
        _: &AccessContext,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Option<Record>> {
        bail!("Approvals are not available on this install")
    }
}

fn only_keys(parameters: &Value, allowed: &[&str]) -> Result<()> {
    let fields = parameters
        .as_object()
        .context("Approval parameters must be an object")?;
    ensure!(
        fields.keys().all(|key| allowed.contains(&key.as_str())),
        "Approvals accept only their documented fields"
    );
    Ok(())
}

fn uuid_of(parameters: &Value, key: &str) -> Result<uuid::Uuid> {
    uuid::Uuid::parse_str(
        parameters[key]
            .as_str()
            .with_context(|| format!("{key} is required"))?,
    )
    .with_context(|| format!("{key} must be an id"))
}

fn operation_id_of(parameters: &Value) -> Result<&str> {
    let id = parameters["operationId"]
        .as_str()
        .context("operationId is required")?;
    ensure!(
        !id.is_empty() && id.len() <= OPERATION_ID_LIMIT,
        "operationId must be short and non-empty"
    );
    Ok(id)
}

/// Routes one port request to the store as the caller. The module and resource are pinned by
/// the call, so a module can only ever see approvals its own code created.
pub fn invoke(store: &dyn Approvals, scope: &CallScope, r: &Request) -> Result<Value> {
    let access = scope.access();
    let module = scope.module().id.as_str();
    // The resource is the declared approval family. `authorize` already checked the manifest
    // lists it for this operation.
    let resource = r.resource.as_str();
    match r.operation.as_str() {
        "create" => {
            only_keys(&r.parameters, &["inputSummary"])?;
            let summary = r
                .parameters
                .get("inputSummary")
                .context("inputSummary is required")?;
            ensure!(
                summary.is_object(),
                "inputSummary must be an object binding the approval"
            );
            ensure!(
                serde_json::to_vec(summary)?.len() <= SUMMARY_LIMIT,
                "inputSummary exceeds its limit"
            );
            Ok(store.create(access, module, resource, summary)?.reply())
        }
        "get" => {
            only_keys(&r.parameters, &["id"])?;
            let id = uuid_of(&r.parameters, "id")?;
            Ok(store.get(access, module, resource, &id.to_string())?.reply())
        }
        "confirm" => {
            only_keys(&r.parameters, &["id"])?;
            let id = uuid_of(&r.parameters, "id")?;
            Ok(store
                .confirm(access, module, resource, &id.to_string())?
                .reply())
        }
        "find-pending" => {
            only_keys(&r.parameters, &["operationId"])?;
            let operation_id = operation_id_of(&r.parameters)?.to_owned();
            let found = store.find(access, module, resource, "pending", &operation_id)?;
            Ok(json!({"approval": found.map(|record| record.reply())}))
        }
        "find-confirmed" => {
            only_keys(&r.parameters, &["operationId"])?;
            let operation_id = operation_id_of(&r.parameters)?.to_owned();
            let found = store.find(access, module, resource, "confirmed", &operation_id)?;
            Ok(json!({"approval": found.map(|record| record.reply())}))
        }
        _ => bail!("Unknown approvals operation"),
    }
}

/// The store over the host approval table. Each call opens its own transaction as the caller.
pub struct PostgresApprovals {
    database: Database,
    runtime: Runtime,
}

impl PostgresApprovals {
    pub fn new(database: Database) -> Result<Self> {
        Ok(Self {
            database,
            runtime: Runtime::new()?,
        })
    }

    fn open(&self, access: &AccessContext) -> Result<DataContext> {
        self.runtime
            .block_on(DataContext::open(&self.database, access))
            .map_err(|_| anyhow::anyhow!("Could not open the approvals data context"))
    }

    fn row(&self, row: &tokio_postgres::Row) -> Record {
        Record {
            id: row.get::<_, uuid::Uuid>(0).to_string(),
            owner_user_id: row.get::<_, uuid::Uuid>(1).to_string(),
            status: row.get::<_, String>(2),
            input_summary: row.get::<_, Value>(3),
        }
    }
}

const SELECT_COLUMNS: &str = "id, owner_user_id, status, input_summary";

impl Approvals for PostgresApprovals {
    fn create(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        input_summary: &Value,
    ) -> Result<Record> {
        let cx = self.open(access)?;
        self.runtime.block_on(async {
            let id = uuid::Uuid::new_v4();
            // The host sets the row owner; row security re-checks it against the actor.
            let row = cx
                .db()
                .query_one(
                    &format!(
                        "INSERT INTO moss_modules.approvals \
                         (id, owner_user_id, module_id, resource, status, input_summary) \
                         VALUES ($1,$2,$3,$4,'pending',$5) RETURNING {SELECT_COLUMNS}"
                    ),
                    &[
                        &id,
                        &cx.actor_user_id(),
                        &module,
                        &resource,
                        input_summary,
                    ],
                )
                .await
                .map_err(|_| anyhow::anyhow!("The approval could not be saved"))?;
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Could not commit the approval"))?;
            Ok(self.row(&row))
        })
    }

    fn get(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        id: &str,
    ) -> Result<Record> {
        let cx = self.open(access)?;
        self.runtime.block_on(async {
            let id = uuid::Uuid::parse_str(id).context("The approval id is not valid")?;
            // Row security scopes the owner, so another account's id finds no row.
            let row = cx
                .db()
                .query_opt(
                    &format!(
                        "SELECT {SELECT_COLUMNS} FROM moss_modules.approvals \
                         WHERE id = $1 AND module_id = $2 AND resource = $3"
                    ),
                    &[&id, &module, &resource],
                )
                .await
                .map_err(|_| anyhow::anyhow!("Could not read the approval"))?
                .context("Approval not found")?;
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Could not finish reading the approval"))?;
            Ok(self.row(&row))
        })
    }

    fn confirm(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        id: &str,
    ) -> Result<Record> {
        let cx = self.open(access)?;
        self.runtime.block_on(async {
            let id = uuid::Uuid::parse_str(id).context("The approval id is not valid")?;
            // One conditional update: only a pending row of this module flips to confirmed,
            // so a replayed confirm updates nothing and is refused.
            let row = cx
                .db()
                .query_opt(
                    &format!(
                        "UPDATE moss_modules.approvals \
                         SET status = 'confirmed', resolved_at = now(), updated_at = now() \
                         WHERE id = $1 AND module_id = $2 AND resource = $3 AND status = 'pending' \
                         RETURNING {SELECT_COLUMNS}"
                    ),
                    &[&id, &module, &resource],
                )
                .await
                .map_err(|_| anyhow::anyhow!("Could not confirm the approval"))?
                .context("The approval is not pending")?;
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Could not commit the confirmation"))?;
            Ok(self.row(&row))
        })
    }

    fn find(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        status: &str,
        operation_id: &str,
    ) -> Result<Option<Record>> {
        let cx = self.open(access)?;
        self.runtime.block_on(async {
            // The operation is the one the module bound into the input summary, exactly as
            // the TypeScript port scans its store for the binding's operation.
            let row = cx
                .db()
                .query_opt(
                    &format!(
                        "SELECT {SELECT_COLUMNS} FROM moss_modules.approvals \
                         WHERE module_id = $1 AND resource = $2 AND status = $3 \
                         AND input_summary->>'operationId' = $4 \
                         ORDER BY requested_at DESC LIMIT 1"
                    ),
                    &[&module, &resource, &status, &operation_id],
                )
                .await
                .map_err(|_| anyhow::anyhow!("Could not search approvals"))?;
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Could not finish searching approvals"))?;
            Ok(row.as_ref().map(|row| self.row(row)))
        })
    }
}

/// Wraps a store for `ServicePorts::with_approvals`.
pub fn shared(store: impl Approvals + 'static) -> Arc<dyn Approvals> {
    Arc::new(store)
}
