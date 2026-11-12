//! Export and deletion of one person's memory. Both act only on the signed-in person's rows.
//! Export reads one section per call in pages that stay under the host's message limit, and
//! never returns vectors. Deletion removes every owned table's rows for that person and
//! returns counts only, so no memory text reaches logs, jobs or activity rows.
use crate::recording;
use anyhow::{anyhow, Result};
use moss_module_host::database::runtime_role;
use safety_core::db::DataContext;
use serde_json::{json, Value};

/// Largest page, in bytes of row text. The host refuses messages over 1 MiB.
const PAGE_BYTES: usize = 400 * 1024;
const PAGE_ROWS: i64 = 500;

fn ts(column: &str, alias: &str) -> String {
    format!("'{alias}', to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}

/// One exported section: name, table, the keyset column the pages walk, and the row object.
struct Section {
    name: &'static str,
    table: &'static str,
    key: &'static str,
    object: String,
}

fn sections() -> Vec<Section> {
    let s = |name, table, key, object: String| Section { name, table, key, object };
    vec![
        s("memoryChunks", "app.memory_chunks", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'sourceKind', source_kind,
             'sourcePath', source_path, 'lineStart', line_start, 'lineEnd', line_end, 'text', text,
             'managedSnapshot', managed_snapshot, {}", ts("updated_at", "updatedAt"))),
        s("chatMemoryFacts", "app.chat_memory_facts", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'category', category,
             'content', content, 'sourceThreadId', source_thread_id::text, 'importance', importance,
             'status', status, {}, {}, {}", ts("superseded_at", "supersededAt"),
            ts("created_at", "createdAt"), ts("updated_at", "updatedAt"))),
        s("memoryEntities", "app.memory_entities", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'kind', kind, 'name', name,
             'summary', summary, 'status', status, 'importance', importance::text, 'pinned', pinned,
             {}, {}", ts("created_at", "createdAt"), ts("updated_at", "updatedAt"))),
        s("memoryFacts", "app.memory_facts", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'subjectEntityId', subject_entity_id::text,
             'predicate', predicate, 'objectEntityId', object_entity_id::text, 'objectText', object_text,
             'recordingSide', recording_side, 'recordKind', record_kind, 'confidence', confidence::text,
             'provenance', provenance, 'status', status, {}, {}, {},
             'supersededByFactId', superseded_by_fact_id::text, 'conflictGroupId', conflict_group_id::text,
             {}, 'importance', importance::text, 'pinned', pinned, {}, {}",
            ts("valid_from", "validFrom"), ts("valid_to", "validTo"), ts("stale_at", "staleAt"),
            ts("last_confirmed_at", "lastConfirmedAt"), ts("created_at", "createdAt"),
            ts("updated_at", "updatedAt"))),
        s("memoryEpisodes", "app.memory_episodes", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'sourceKind', source_kind,
             'sourceRef', source_ref, 'sourceLabel', source_label, {}, 'recordingSide', recording_side,
             'recordingActive', recording_active, 'excerpt', excerpt, {}",
            ts("occurred_at", "occurredAt"), ts("created_at", "createdAt"))),
        s("memoryFactSources", "app.memory_fact_sources", "fact_id::text || ':' || episode_id::text", format!(
            "'ownerUserId', owner_user_id::text, 'factId', fact_id::text, 'episodeId', episode_id::text, {}",
            ts("created_at", "createdAt"))),
        s("memoryAliases", "app.memory_aliases", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'entityId', entity_id::text,
             'alias', alias, 'normalizedAlias', normalized_alias, 'ambiguous', ambiguous, {}, {}",
            ts("created_at", "createdAt"), ts("updated_at", "updatedAt"))),
        s("memoryConflictGroups", "app.memory_conflict_groups", "id::text", format!(
            "'ownerUserId', owner_user_id::text, 'id', id::text, 'status', status, {}, {}",
            ts("created_at", "createdAt"), ts("resolved_at", "resolvedAt"))),
        s("memoryCandidates", "app.memory_candidates", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'episodeId', episode_id::text,
             'kind', kind, 'action', action, 'payloadJson', payload_json - 'excerpt',
             'candidateSignature', candidate_signature, 'status', status, 'confidence', confidence::text,
             'importance', importance::text, 'provenance', provenance, 'promotionReason', promotion_reason,
             {}, {}, {}", ts("created_at", "createdAt"), ts("updated_at", "updatedAt"),
            ts("resolved_at", "resolvedAt"))),
        s("memorySearchDocuments", "app.memory_search_documents", "id::text", format!(
            "'id', id::text, 'ownerUserId', owner_user_id::text, 'targetKind', target_kind,
             'targetId', target_id::text, 'recordingSide', recording_side,
             'recordingRevision', recording_revision::text, 'searchText', search_text,
             'embedModelName', embed_model_name, 'embedModelVersion', embed_model_version,
             'status', status, {}, {}", ts("created_at", "createdAt"), ts("updated_at", "updatedAt"))),
        s("memoryLegacyFactMigrations", "app.memory_legacy_fact_migrations", "legacy_fact_id::text", format!(
            "'ownerUserId', owner_user_id::text, 'legacyFactId', legacy_fact_id::text,
             'memoryFactId', memory_fact_id::text, {}", ts("created_at", "createdAt"))),
    ]
}

/// Section names in the order a caller should read them.
pub fn names() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = sections().iter().map(|s| s.name).collect();
    all.push("recordingMemory");
    all
}

/// One page of one section. `after` is the key the previous page ended on.
pub async fn export(cx: &DataContext, section: &str, after: Option<&str>) -> Result<Value> {
    if section == "recordingMemory" {
        return Ok(json!({"section": section, "rows": recording::export(cx).await?, "next": null}));
    }
    let all = sections();
    let found = all
        .iter()
        .find(|s| s.name == section)
        .ok_or_else(|| anyhow!("Unknown export section"))?;
    let sql = format!(
        "SELECT k, j::text FROM (
           SELECT {key} AS k, jsonb_build_object({object}) AS j FROM {table}
           WHERE owner_user_id = app.current_actor_user_id() AND ($1::text IS NULL OR {key} > $1::text)
           ORDER BY {key} LIMIT {PAGE_ROWS} + 1) page ORDER BY k",
        key = found.key,
        object = found.object,
        table = found.table
    );
    let rows = cx.db().query(&sql, &[&after]).await?;
    let (mut out, mut bytes, mut last) = (Vec::new(), 0usize, None::<String>);
    let mut more = false;
    for (i, row) in rows.iter().enumerate() {
        let (key, text): (String, String) = (row.get(0), row.get(1));
        if i as i64 >= PAGE_ROWS || (bytes + text.len() > PAGE_BYTES && !out.is_empty()) {
            more = true;
            break;
        }
        bytes += text.len();
        out.push(serde_json::from_str::<Value>(&text)?);
        last = Some(key);
    }
    Ok(json!({"section": section, "rows": out, "next": if more { json!(last) } else { Value::Null }}))
}

/// Tables in the order that satisfies their references, and the role that owns each.
/// The three module tables belong to the module's own database role.
const DELETE_ORDER: &[(&str, bool)] = &[
    ("app.memory_reembed_staged", true),
    ("app.memory_reembed_runs", true),
    ("app.memory_ingest_nudges", true),
    ("app.memory_recording_proposals", false),
    ("app.memory_recording_receipts", false),
    ("app.memory_search_documents", false),
    ("app.memory_candidates", false),
    ("app.memory_fact_sources", false),
    ("app.memory_legacy_fact_migrations", false),
    ("app.memory_aliases", false),
    ("app.memory_facts", false),
    ("app.memory_conflict_groups", false),
    ("app.memory_episodes", false),
    ("app.memory_entities", false),
    ("app.chat_memory_facts", false),
    ("app.memory_links", false),
    ("app.memory_chunks", false),
    ("app.memory_file_index", false),
    ("app.memory_recording_fact_versions", false),
];

/// Deletes everything the signed-in person has in Memory and returns how many rows each table
/// lost. Recording fact versions go last because they outlive the facts they describe.
pub async fn delete_all(cx: &DataContext) -> Result<Value> {
    let mut counts = serde_json::Map::new();
    let mut total = 0u64;
    for (table, module_owned) in DELETE_ORDER {
        if *module_owned {
            cx.db()
                .batch_execute(&format!("SET LOCAL ROLE {}", runtime_role(crate::MODULE_ID)))
                .await?;
        }
        let removed = cx
            .db()
            .execute(
                &format!("DELETE FROM {table} WHERE owner_user_id = app.current_actor_user_id()"),
                &[],
            )
            .await?;
        if *module_owned {
            cx.db().batch_execute("RESET ROLE").await?;
        }
        total += removed;
        counts.insert((*table).to_owned(), json!(removed));
    }
    cx.db().batch_execute("SET CONSTRAINTS ALL IMMEDIATE").await?;
    Ok(json!({"deleted": counts, "total": total}))
}
