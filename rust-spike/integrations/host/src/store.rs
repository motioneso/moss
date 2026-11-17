//! Reads and writes of `app.integration_connections`. Every call runs inside a `DataContext`,
//! so row-level security keeps each person to their own rows.
use moss_integrations::{
    sortmap::{
        parse_sort_map, sort_map_json, with_send_without_asking, with_tool_sort_results,
        without_stale_send_choices, SortMap,
    },
    sort::ToolResult,
    tool::Tool,
};
use serde_json::Value;
use tokio_postgres::{types::Json, Client, Error, Row as PgRow};

const TIME: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

fn columns() -> String {
    format!(
        "id::text, name, kind, url, credential_placement, (credential IS NOT NULL), enabled,
         base_url, spec_pasted, enabled_groups, enabled_tools, muted_tools, unsuppressed_tools,
         classifier_enabled, classifier_sort, classifier_kept_out_tools, discovered_tools,
         to_char(last_discovery_at AT TIME ZONE 'UTC', {TIME}), last_error"
    )
}

/// One connection as the routes and the worker read it. The credential never appears here.
#[derive(Clone, Debug)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub url: String,
    pub credential_placement: Option<Value>,
    pub has_credential: bool,
    pub enabled: bool,
    pub base_url: Option<String>,
    pub spec_pasted: bool,
    pub enabled_groups: Vec<String>,
    pub enabled_tools: Vec<String>,
    pub muted_tools: Vec<String>,
    pub unsuppressed_tools: Vec<String>,
    pub classifier_enabled: bool,
    pub classifier_sort: SortMap,
    pub classifier_kept_out_tools: Vec<String>,
    pub discovered_tools: Vec<Tool>,
    pub last_discovery_at: Option<String>,
    pub last_error: Option<String>,
}

fn map(row: &PgRow) -> Row {
    let tools: Value = row.get::<_, Json<Value>>(16).0;
    let discovered = match tools {
        Value::Array(items) => items.into_iter().filter_map(|t| serde_json::from_value(t).ok()).collect(),
        _ => Vec::new(),
    };
    Row {
        id: row.get(0),
        name: row.get(1),
        kind: row.get(2),
        url: row.get(3),
        credential_placement: row.get::<_, Option<Json<Value>>>(4).map(|j| j.0),
        has_credential: row.get(5),
        enabled: row.get(6),
        base_url: row.get(7),
        spec_pasted: row.get(8),
        enabled_groups: row.get(9),
        enabled_tools: row.get(10),
        muted_tools: row.get(11),
        unsuppressed_tools: row.get(12),
        classifier_enabled: row.get(13),
        classifier_sort: parse_sort_map(&row.get::<_, Json<Value>>(14).0),
        classifier_kept_out_tools: row.get(15),
        discovered_tools: discovered,
        last_discovery_at: row.get(17),
        last_error: row.get(18),
    }
}

pub async fn list(db: &Client) -> Result<Vec<Row>, Error> {
    let sql = format!("SELECT {} FROM app.integration_connections ORDER BY created_at DESC", columns());
    Ok(db.query(&sql, &[]).await?.iter().map(map).collect())
}

pub async fn get(db: &Client, id: &str, lock: bool) -> Result<Option<Row>, Error> {
    let sql = format!(
        "SELECT {} FROM app.integration_connections WHERE id = $1::text::uuid{}",
        columns(),
        if lock { " FOR UPDATE" } else { "" }
    );
    Ok(db.query_opt(&sql, &[&id]).await?.as_ref().map(map))
}

pub struct NewConnection<'a> {
    pub name: &'a str,
    pub kind: &'a str,
    pub url: &'a str,
    pub base_url: Option<&'a str>,
    pub spec_pasted: bool,
    pub credential: Option<Value>,
    pub placement: Option<Value>,
}

pub async fn create(db: &Client, new: &NewConnection<'_>) -> Result<Row, Error> {
    let sql = format!(
        "INSERT INTO app.integration_connections
           (owner_user_id, name, kind, url, credential, credential_placement, base_url, spec_pasted)
         VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING {}",
        columns()
    );
    let credential = new.credential.clone().map(Json);
    let placement = new.placement.clone().map(Json);
    let row = db
        .query_one(&sql, &[&new.name, &new.kind, &new.url, &credential, &placement, &new.base_url, &new.spec_pasted])
        .await?;
    Ok(map(&row))
}

/// The only read of the `credential` column. The value goes to the caller and nowhere else.
pub async fn credential_envelope(db: &Client, id: &str) -> Result<Option<Value>, Error> {
    let row = db
        .query_opt("SELECT credential FROM app.integration_connections WHERE id = $1::text::uuid", &[&id])
        .await?;
    Ok(row.and_then(|r| r.get::<_, Option<Json<Value>>>(0)).map(|j| j.0))
}

/// Fields a PATCH may change. `None` leaves a column alone.
#[derive(Default)]
pub struct Patch {
    pub name: Option<String>,
    pub url: Option<String>,
    pub enabled: Option<bool>,
    pub base_url: Option<Option<String>>,
    pub spec_pasted: Option<bool>,
    pub credential: Option<Option<Value>>,
    pub placement: Option<Option<Value>>,
    pub enabled_groups: Option<Vec<String>>,
    pub enabled_tools: Option<Vec<String>>,
    pub muted_tools: Option<Vec<String>>,
    pub unsuppressed_tools: Option<Vec<String>>,
    pub classifier_enabled: Option<bool>,
}

pub async fn update(db: &Client, id: &str, patch: &Patch) -> Result<Option<Row>, Error> {
    let credential = patch.credential.clone().map(|c| c.map(Json));
    let placement = patch.placement.clone().map(|c| c.map(Json));
    // Each column takes the new value only when its flag is true.
    let sql = format!(
        "UPDATE app.integration_connections SET
           name = CASE WHEN $2 THEN $3 ELSE name END,
           url = CASE WHEN $4 THEN $5 ELSE url END,
           enabled = CASE WHEN $6 THEN $7 ELSE enabled END,
           base_url = CASE WHEN $8 THEN $9 ELSE base_url END,
           spec_pasted = CASE WHEN $10 THEN $11 ELSE spec_pasted END,
           credential = CASE WHEN $12 THEN $13 ELSE credential END,
           credential_placement = CASE WHEN $14 THEN $15 ELSE credential_placement END,
           enabled_groups = CASE WHEN $16 THEN $17 ELSE enabled_groups END,
           enabled_tools = CASE WHEN $18 THEN $19 ELSE enabled_tools END,
           muted_tools = CASE WHEN $20 THEN $21 ELSE muted_tools END,
           unsuppressed_tools = CASE WHEN $22 THEN $23 ELSE unsuppressed_tools END,
           classifier_enabled = CASE WHEN $24 THEN $25 ELSE classifier_enabled END,
           updated_at = now()
         WHERE id = $1::text::uuid RETURNING {}",
        columns()
    );
    let empty: Vec<String> = Vec::new();
    let row = db
        .query_opt(
            &sql,
            &[
                &id,
                &patch.name.is_some(), &patch.name.clone().unwrap_or_default(),
                &patch.url.is_some(), &patch.url.clone().unwrap_or_default(),
                &patch.enabled.is_some(), &patch.enabled.unwrap_or(true),
                &patch.base_url.is_some(), &patch.base_url.clone().flatten(),
                &patch.spec_pasted.is_some(), &patch.spec_pasted.unwrap_or(false),
                &credential.is_some(), &credential.flatten(),
                &placement.is_some(), &placement.flatten(),
                &patch.enabled_groups.is_some(), patch.enabled_groups.as_ref().unwrap_or(&empty),
                &patch.enabled_tools.is_some(), patch.enabled_tools.as_ref().unwrap_or(&empty),
                &patch.muted_tools.is_some(), patch.muted_tools.as_ref().unwrap_or(&empty),
                &patch.unsuppressed_tools.is_some(), patch.unsuppressed_tools.as_ref().unwrap_or(&empty),
                &patch.classifier_enabled.is_some(), &patch.classifier_enabled.unwrap_or(false),
            ],
        )
        .await?;
    Ok(row.as_ref().map(map))
}

pub async fn delete(db: &Client, id: &str) -> Result<bool, Error> {
    Ok(db.execute("DELETE FROM app.integration_connections WHERE id = $1::text::uuid", &[&id]).await? > 0)
}

/// Stores a discovery, or its failure when `tools` is `None`. A send-without-asking choice dies
/// with the sort it was set on, so a tool whose risk inputs changed asks again.
pub async fn save_discovery(db: &Client, id: &str, tools: Option<&[Tool]>, error: Option<&str>) -> Result<(), Error> {
    let Some(tools) = tools else {
        db.execute(
            "UPDATE app.integration_connections SET last_error = $2, updated_at = now() WHERE id = $1::text::uuid",
            &[&id, &error],
        )
        .await?;
        return Ok(());
    };
    let Some(row) = get(db, id, true).await? else { return Ok(()) };
    let sort = without_stale_send_choices(&row.classifier_sort, tools);
    let tools_json = Json(serde_json::to_value(tools).unwrap_or(Value::Null));
    db.execute(
        "UPDATE app.integration_connections
         SET discovered_tools = $2, classifier_sort = $3, last_discovery_at = now(), last_error = $4,
             updated_at = now()
         WHERE id = $1::text::uuid",
        &[&id, &tools_json, &Json(sort_map_json(&sort)), &error],
    )
    .await?;
    Ok(())
}

async fn write_sort(db: &Client, id: &str, sort: &SortMap) -> Result<Option<Row>, Error> {
    let sql = format!(
        "UPDATE app.integration_connections SET classifier_sort = $2, updated_at = now()
         WHERE id = $1::text::uuid RETURNING {}",
        columns()
    );
    Ok(db.query_opt(&sql, &[&id, &Json(sort_map_json(sort))]).await?.as_ref().map(map))
}

pub async fn save_sorts(db: &Client, id: &str, results: &[ToolResult]) -> Result<Option<Row>, Error> {
    let Some(row) = get(db, id, true).await? else { return Ok(None) };
    let pairs: Vec<_> = results.iter().map(|r| (r.tool_name.clone(), r.result.clone())).collect();
    let sort = with_tool_sort_results(&row.classifier_sort, &row.discovered_tools, &pairs);
    write_sort(db, id, &sort).await
}

pub enum SendOutcome {
    Saved(Row),
    NotFound,
    Refused,
}

pub async fn set_send_without_asking(db: &Client, id: &str, names: &[String], allow: bool) -> Result<SendOutcome, Error> {
    let Some(row) = get(db, id, true).await? else { return Ok(SendOutcome::NotFound) };
    let mut sort = row.classifier_sort.clone();
    for name in names {
        let tool = row.discovered_tools.iter().find(|t| &t.name == name);
        let next = match tool {
            Some(tool) => with_send_without_asking(&sort, tool, allow),
            None if allow => None,
            None => Some(sort.clone()),
        };
        match next {
            Some(next) => sort = next,
            None => return Ok(SendOutcome::Refused),
        }
    }
    Ok(write_sort(db, id, &sort).await?.map_or(SendOutcome::NotFound, SendOutcome::Saved))
}

pub enum KeptOutOutcome {
    Saved(Row),
    NotFound,
    UnknownTool,
}

pub async fn set_kept_out(db: &Client, id: &str, names: &[String], kept_out: bool) -> Result<KeptOutOutcome, Error> {
    let Some(row) = get(db, id, true).await? else { return Ok(KeptOutOutcome::NotFound) };
    if names.iter().any(|n| !row.discovered_tools.iter().any(|t| &t.name == n)) {
        return Ok(KeptOutOutcome::UnknownTool);
    }
    let next: Vec<String> = if kept_out {
        let mut all = row.classifier_kept_out_tools.clone();
        for n in names {
            if !all.contains(n) {
                all.push(n.clone());
            }
        }
        all
    } else {
        row.classifier_kept_out_tools.iter().filter(|t| !names.contains(t)).cloned().collect()
    };
    let sql = format!(
        "UPDATE app.integration_connections SET classifier_kept_out_tools = $2, updated_at = now()
         WHERE id = $1::text::uuid RETURNING {}",
        columns()
    );
    let updated = db.query_opt(&sql, &[&id, &next]).await?;
    Ok(updated.as_ref().map_or(KeptOutOutcome::NotFound, |r| KeptOutOutcome::Saved(map(r))))
}

/// Connections with a tool that has never been sorted. Ids only.
pub async fn needing_sort(db: &Client) -> Result<Vec<(String, String)>, Error> {
    let rows = db
        .query("SELECT owner_user_id::text, connection_id::text FROM app.list_integration_connections_needing_sort()", &[])
        .await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}
