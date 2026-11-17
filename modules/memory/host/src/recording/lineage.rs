//! Admission for managed facts, and the two lineage moves: transferring a fact's recording
//! association to its replacement, and synchronising derivatives after a transition.
use super::{changed, is_uuid, must, RecordingAuthority};
use anyhow::Result;
use moss_module_host::trust::digest;
use safety_core::db::DataContext;
use serde_json::{json, Value};

/// The facts a change touches (with their conflict groups) and their recording associations.
pub(crate) struct Set {
    pub facts: Value,
    pub assoc: Value,
}
impl Set {
    pub fn fingerprint(&self) -> String {
        digest(json!([self.facts, self.assoc]).to_string().as_bytes())
    }
    pub fn managed(&self) -> bool {
        self.facts
            .as_array()
            .is_some_and(|f| f.iter().any(|x| !x["rev"].is_null()))
    }
    pub fn ids(&self) -> Vec<String> {
        self.facts.as_array().map_or_else(Vec::new, |f| {
            f.iter()
                .filter_map(|x| x["id"].as_str().map(str::to_owned))
                .collect()
        })
    }
    fn strings(&self, key: &str) -> Vec<String> {
        let mut out: Vec<String> = self.facts.as_array().map_or_else(Vec::new, |f| {
            f.iter()
                .flat_map(|x| {
                    key.split(',')
                        .filter_map(|k| x[k].as_str().map(str::to_owned))
                })
                .collect()
        });
        out.sort();
        out.dedup();
        out
    }
}

pub(crate) async fn discover(cx: &DataContext, owner: &str, ids: &[String]) -> Result<Set> {
    let facts: Value = cx
        .db()
        .query_one(
            "SELECT COALESCE(jsonb_agg(jsonb_build_object('id', f.id::text, 'subject', f.subject_entity_id::text,
                'object', f.object_entity_id::text, 'group', f.conflict_group_id::text, 'xmin', f.xmin::text,
                'side', f.recording_side, 'rev', v.revision::text) ORDER BY f.id), '[]'::jsonb)
             FROM app.memory_facts f
             LEFT JOIN app.memory_recording_fact_versions v
               ON v.owner_user_id = f.owner_user_id AND v.fact_id = f.id
             WHERE f.owner_user_id = $1::text::uuid
               AND (f.id = ANY($2::text[]::uuid[]) OR f.conflict_group_id IN (
                 SELECT conflict_group_id FROM app.memory_facts
                 WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[])))",
            &[&owner, &ids],
        )
        .await?
        .get(0);
    let fact_ids: Vec<String> = facts.as_array().map_or_else(Vec::new, |f| {
        f.iter()
            .filter_map(|x| x["id"].as_str().map(str::to_owned))
            .collect()
    });
    let assoc: Value = cx
        .db()
        .query_one(
            "SELECT COALESCE(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'factId', fact_id::text,
                'sourceId', source_id::text, 'sourceVersion', source_version, 'itemKey', item_key,
                'generation', source_generation, 'revision', revision, 'side', side, 'state', state)
                ORDER BY receipt_id), '[]'::jsonb)
             FROM app.memory_recording_receipts
             WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[])",
            &[&owner, &fact_ids],
        )
        .await?
        .get(0);
    Ok(Set { facts, assoc })
}

fn source_ids(set: &Set) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in set.assoc.as_array().into_iter().flatten() {
        if let Some(id) = a["sourceId"].as_str() {
            if !out.iter().any(|x| x == id) {
                out.push(id.to_owned());
            }
        }
    }
    out
}

/// Captures the generation of every source the change touches. Capture grants nothing; the
/// authority is asked again when the change publishes.
pub(crate) fn snapshot(
    authority: &dyn RecordingAuthority,
    owner: &str,
    extra: &[String],
    set: &Set,
) -> Result<Value> {
    let mut ids: Vec<String> = extra.to_vec();
    for id in source_ids(set) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut sources = Vec::new();
    let mut actor_generation = 0;
    for id in &ids {
        let state = authority.current(owner, id).ok_or_else(changed)?;
        actor_generation = state.actor_generation;
        sources.push(
            json!({"source": {"ownerUserId": owner, "sourceModuleId": "meetings", "sourceId": id},
                            "generation": state.generation}),
        );
    }
    Ok(json!({"ownerUserId": owner, "actorGeneration": actor_generation, "sources": sources}))
}

async fn lock_set(cx: &DataContext, owner: &str, set: &Set) -> Result<()> {
    let (entities, groups) = (set.strings("subject,object"), set.strings("group"));
    let facts = set.ids();
    // NOWAIT keeps contention a bounded rollback instead of a wait.
    let steps: [(&str, &Vec<String>); 5] = [
        ("SELECT id FROM app.memory_entities WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[]) ORDER BY id FOR SHARE NOWAIT", &entities),
        ("SELECT id FROM app.memory_conflict_groups WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[]) ORDER BY id FOR UPDATE NOWAIT", &groups),
        ("SELECT id FROM app.memory_facts WHERE owner_user_id = $1::text::uuid AND id = ANY($2::text[]::uuid[]) ORDER BY id FOR UPDATE NOWAIT", &facts),
        ("SELECT fact_id FROM app.memory_recording_fact_versions WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[]) ORDER BY fact_id FOR UPDATE NOWAIT", &facts),
        ("SELECT receipt_id FROM app.memory_recording_receipts WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[]) ORDER BY receipt_id FOR UPDATE NOWAIT", &facts),
    ];
    for (sql, ids) in steps {
        cx.db().query(sql, &[&owner, ids]).await?;
    }
    Ok(())
}

/// Admits a prepared change. The captured snapshot must match what Meetings reports now and
/// what each receipt recorded (except the source being reconciled), and the locked set must
/// be unchanged since it was read.
pub(crate) async fn admit(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    snap: &Value,
    ids: &[String],
    reconciling: Option<&str>,
) -> Result<Set> {
    let initial = discover(cx, owner, ids).await?;
    let captured = snap["sources"].as_array().cloned().unwrap_or_default();
    let generation_of = |id: &str| {
        captured
            .iter()
            .find(|c| c["source"]["sourceId"] == id)
            .and_then(|c| c["generation"].as_i64())
    };
    for a in initial.assoc.as_array().into_iter().flatten() {
        let id = a["sourceId"].as_str().unwrap_or("");
        match generation_of(id) {
            None => return Err(changed()),
            Some(g) if reconciling != Some(id) && Some(g) != a["generation"].as_i64() => {
                return Err(changed())
            }
            _ => {}
        }
    }
    for c in &captured {
        let id = c["source"]["sourceId"].as_str().unwrap_or("");
        let now = authority.current(owner, id).ok_or_else(changed)?;
        if Some(i64::from(now.generation)) != c["generation"].as_i64()
            || Some(i64::from(now.actor_generation)) != snap["actorGeneration"].as_i64()
        {
            return Err(changed());
        }
    }
    lock_set(cx, owner, &initial).await?;
    if discover(cx, owner, ids).await?.fingerprint() != initial.fingerprint() {
        return Err(changed());
    }
    Ok(initial)
}

/// Admission for a change to a fact outside a prepared proposal. Unmanaged facts pass.
async fn admit_facts(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    ids: &[String],
) -> Result<bool> {
    let initial = discover(cx, owner, ids).await?;
    if !initial.managed() {
        return Ok(false);
    }
    if initial.assoc.as_array().is_none_or(|a| a.is_empty()) {
        return Err(changed());
    }
    let snap = snapshot(authority, owner, &[], &initial)?;
    admit(cx, authority, owner, &snap, ids, None).await?;
    Ok(true)
}

fn ids_of(p: &Value, name: &str) -> Result<Vec<String>> {
    let mut ids: Vec<String> = p[name]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(str::to_lowercase)
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    anyhow::ensure!(ids.iter().all(|i| is_uuid(i)), "Invalid fact id");
    Ok(ids)
}

pub(crate) async fn transfer_call(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    p: &Value,
) -> Result<Value> {
    let from = ids_of(p, "fromIds")?;
    let replacement = must(p, "replacementId")?.to_lowercase();
    anyhow::ensure!(is_uuid(&replacement), "Invalid fact id");
    let mut all = from.clone();
    all.push(replacement.clone());
    admit_facts(cx, authority, owner, &all).await?;
    transfer(
        cx,
        owner,
        &from,
        &replacement,
        p["corrected"].as_bool().unwrap_or(false),
    )
    .await?;
    Ok(json!({"ok": true}))
}

pub(crate) async fn synchronize_call(
    cx: &DataContext,
    authority: &dyn RecordingAuthority,
    owner: &str,
    p: &Value,
) -> Result<Value> {
    let ids = ids_of(p, "factIds")?;
    admit_facts(cx, authority, owner, &ids).await?;
    synchronize(cx, owner, &ids).await?;
    Ok(json!({"ok": true}))
}

/// Moves recording associations from `from` to `replacement`. Mixed or retired groups are
/// refused so a resolution never absorbs unlabelled or opposite-side facts.
pub(crate) async fn transfer(
    cx: &DataContext,
    owner: &str,
    from: &[String],
    replacement: &str,
    corrected: bool,
) -> Result<()> {
    let rows = cx
        .db()
        .query(
            "SELECT fact_id::text, lineage_id::text, side, state, corrected
             FROM app.memory_recording_fact_versions
             WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[]) ORDER BY fact_id",
            &[&owner, &from],
        )
        .await?;
    let Some(first) = rows.first() else {
        return Ok(());
    };
    let (lineage, side): (String, String) = (first.get(1), first.get(2));
    if rows.len() != from.len()
        || rows
            .iter()
            .any(|r| r.get::<_, String>(2) != side || r.get::<_, String>(3) != "current")
    {
        return Err(changed());
    }
    let corrected = corrected || rows.iter().any(|r| r.get::<_, bool>(4));
    let existing = cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.memory_recording_fact_versions
             WHERE owner_user_id = $1::text::uuid AND fact_id = $2::text::uuid",
            &[&owner, &replacement],
        )
        .await?;
    if existing.is_none() {
        cx.db()
            .execute(
                "INSERT INTO app.memory_recording_fact_versions(owner_user_id, fact_id, lineage_id, side, corrected)
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5)",
                &[&owner, &replacement, &lineage, &side, &corrected],
            )
            .await?;
        cx.db()
            .execute(
                "UPDATE app.memory_facts SET recording_side = $3
                 WHERE owner_user_id = $1::text::uuid AND id = $2::text::uuid",
                &[&owner, &replacement, &side],
            )
            .await?;
    } else if corrected {
        cx.db()
            .execute(
                "UPDATE app.memory_recording_fact_versions SET corrected = true
                 WHERE owner_user_id = $1::text::uuid AND fact_id = $2::text::uuid",
                &[&owner, &replacement],
            )
            .await?;
    }
    cx.db()
        .execute(
            "INSERT INTO app.memory_fact_sources(owner_user_id, fact_id, episode_id)
             SELECT owner_user_id, $2::text::uuid, episode_id FROM app.memory_fact_sources
             WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($3::text[]::uuid[])
             ON CONFLICT (owner_user_id, fact_id, episode_id) DO NOTHING",
            &[&owner, &replacement, &from],
        )
        .await?;
    cx.db()
        .execute(
            "UPDATE app.memory_recording_receipts SET fact_id = $2::text::uuid, revision = revision + 1
             WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($3::text[]::uuid[])
               AND fact_id <> $2::text::uuid AND state IN ('applied','undone')",
            &[&owner, &replacement, &from],
        )
        .await?;
    Ok(())
}

/// Brings receipts, episodes and search documents in line with the facts' current state.
pub(crate) async fn synchronize(cx: &DataContext, owner: &str, fact_ids: &[String]) -> Result<()> {
    let managed = cx
        .db()
        .query(
            "SELECT fact_id::text FROM app.memory_recording_fact_versions
             WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[]) ORDER BY fact_id",
            &[&owner, &fact_ids],
        )
        .await?;
    if managed.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = managed.iter().map(|r| r.get(0)).collect();
    let db = cx.db();
    db.execute(
        "UPDATE app.memory_recording_receipts receipt SET state = 'forgotten', revision = receipt.revision + 1
         FROM app.memory_recording_fact_versions version
         WHERE version.owner_user_id = $1::text::uuid AND version.fact_id = ANY($2::text[]::uuid[])
           AND version.state <> 'current' AND receipt.owner_user_id = version.owner_user_id
           AND receipt.fact_id = version.fact_id AND receipt.state IN ('applied','undone')",
        &[&owner, &ids],
    )
    .await?;
    // A derivative that is busy is never waited on while graph parents are held.
    db.execute(
        "SELECT id FROM app.memory_search_documents WHERE owner_user_id = $1::text::uuid
           AND ((target_kind = 'fact' AND target_id = ANY($2::text[]::uuid[])) OR (target_kind = 'episode' AND target_id IN (
             SELECT episode_id FROM app.memory_recording_receipts
             WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[]))))
         ORDER BY id FOR UPDATE NOWAIT",
        &[&owner, &ids],
    )
    .await?;
    db.execute(
        "SELECT id FROM app.memory_episodes WHERE owner_user_id = $1::text::uuid AND id IN (
           SELECT episode_id FROM app.memory_recording_receipts
           WHERE owner_user_id = $1::text::uuid AND fact_id = ANY($2::text[]::uuid[])) ORDER BY id FOR UPDATE NOWAIT",
        &[&owner, &ids],
    )
    .await?;
    db.execute(
        "UPDATE app.memory_episodes episode
         SET recording_side = receipt.side, recording_active = receipt.state = 'applied'
           AND app.memory_recording_fact_eligible(receipt.owner_user_id, receipt.fact_id, receipt.side)
         FROM app.memory_recording_receipts receipt
         WHERE receipt.owner_user_id = $1::text::uuid AND receipt.fact_id = ANY($2::text[]::uuid[])
           AND episode.owner_user_id = receipt.owner_user_id AND episode.id = receipt.episode_id",
        &[&owner, &ids],
    )
    .await?;
    db.execute(
        "UPDATE app.memory_search_documents document
         SET recording_side = version.side, recording_revision = version.revision,
           status = CASE WHEN app.memory_recording_fact_eligible(version.owner_user_id, version.fact_id, version.side)
             THEN 'active' ELSE 'inactive' END, updated_at = now()
         FROM app.memory_recording_fact_versions version
         WHERE version.owner_user_id = $1::text::uuid AND version.fact_id = ANY($2::text[]::uuid[])
           AND document.owner_user_id = version.owner_user_id
           AND document.target_kind = 'fact' AND document.target_id = version.fact_id",
        &[&owner, &ids],
    )
    .await?;
    db.execute(
        "UPDATE app.memory_search_documents document
         SET recording_side = receipt.side, recording_revision = version.revision,
           search_text = COALESCE(fact.object_text, document.search_text), embedding = NULL,
           embed_model_name = NULL, embed_model_version = NULL,
           status = CASE WHEN app.memory_recording_target_revision(
             receipt.owner_user_id, 'episode', receipt.episode_id, receipt.side) IS NOT NULL
             THEN 'active' ELSE 'inactive' END, updated_at = now()
         FROM app.memory_recording_receipts receipt
         JOIN app.memory_recording_fact_versions version
           ON version.owner_user_id = receipt.owner_user_id AND version.fact_id = receipt.fact_id
         LEFT JOIN app.memory_facts fact ON fact.owner_user_id = version.owner_user_id AND fact.id = version.fact_id
         WHERE receipt.owner_user_id = $1::text::uuid AND receipt.fact_id = ANY($2::text[]::uuid[])
           AND document.owner_user_id = receipt.owner_user_id
           AND document.target_kind = 'episode' AND document.target_id = receipt.episode_id",
        &[&owner, &ids],
    )
    .await?;
    Ok(())
}
