//! The SQL behind the Scratchpad store. Every statement runs in the call's actor transaction, so
//! the row policies on the table decide what is visible. Nothing here logs a value.
use anyhow::Result;
use safety_core::db::DataContext;
use serde_json::{json, Value};

pub const STORE: &str = "scratchpad.store";
const DEFAULT_SHORTCUT: &str = "mod+shift+s";
const TIME: &str = "to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

/// True when the person has connected a notes folder (a non-empty text preference).
const NOTES_FOLDER: &str =
    "SELECT COALESCE((SELECT jsonb_typeof(value_json)='string' AND value_json #>> '{}' <> '' \
     FROM app.preferences WHERE owner_user_id=app.current_actor_user_id() AND key='notes-source-path'),false)";

pub async fn get(cx: &DataContext) -> Result<Value> {
    let folder: bool = cx.db().query_one(NOTES_FOLDER, &[]).await?.get(0);
    let row = cx
        .db()
        .query_opt(&format!("SELECT body,revision,{TIME},sync_to_notes,shortcut FROM app.scratchpads"), &[])
        .await?;
    Ok(match row {
        None => json!({"body": "", "revision": 0, "updatedAt": null, "syncToNotes": false,
            "notesFolderConfigured": folder, "shortcut": DEFAULT_SHORTCUT}),
        Some(r) => json!({"body": r.get::<_, String>(0), "revision": r.get::<_, i32>(1), "updatedAt": r.get::<_, String>(2),
            "syncToNotes": r.get::<_, bool>(3), "notesFolderConfigured": folder, "shortcut": r.get::<_, String>(4)}),
    })
}

/// The stored note as the conflict answer shows it.
async fn current(cx: &DataContext) -> Result<Value> {
    let note = get(cx).await?;
    Ok(json!({"body": note["body"], "revision": note["revision"], "updatedAt": note["updatedAt"]}))
}

/// Compare-and-swap save. Revision 0 means no note exists yet. Another revision must match.
pub async fn put(cx: &DataContext, p: &Value) -> Result<Value> {
    let body = p["body"].as_str().ok_or_else(|| anyhow::anyhow!("body required"))?;
    let revision = p["revision"].as_i64().ok_or_else(|| anyhow::anyhow!("revision required"))?;
    let row = if revision == 0 {
        cx.db()
            .query_opt(
                &format!("INSERT INTO app.scratchpads(user_id,body,revision,sync_to_notes,shortcut,updated_at) \
                 VALUES(app.current_actor_user_id(),$1,1,false,'{DEFAULT_SHORTCUT}',now()) ON CONFLICT(user_id) DO NOTHING \
                 RETURNING revision,{TIME}"),
                &[&body],
            )
            .await?
    } else {
        cx.db()
            .query_opt(
                &format!("UPDATE app.scratchpads SET body=$1,revision=revision+1,updated_at=now() WHERE revision=$2::bigint \
                 RETURNING revision,{TIME}"),
                &[&body, &revision],
            )
            .await?
    };
    Ok(match row {
        Some(r) => json!({"ok": true, "revision": r.get::<_, i32>(0), "updatedAt": r.get::<_, String>(1)}),
        None => json!({"ok": false, "current": current(cx).await?}),
    })
}

/// One statement, so two appends at once cannot overwrite each other. The size check is the
/// database's own, and a violation is reported as too large.
pub async fn append(cx: &DataContext, p: &Value) -> Result<Value> {
    let text = p["text"].as_str().ok_or_else(|| anyhow::anyhow!("text required"))?;
    let row = cx
        .db()
        .query_one(
            &format!("INSERT INTO app.scratchpads(user_id,body,revision,sync_to_notes,shortcut,updated_at) \
             VALUES(app.current_actor_user_id(),$1,1,false,'{DEFAULT_SHORTCUT}',now()) \
             ON CONFLICT(user_id) DO UPDATE SET \
             body=CASE WHEN app.scratchpads.body='' THEN EXCLUDED.body ELSE app.scratchpads.body||E'\\n'||EXCLUDED.body END, \
             revision=app.scratchpads.revision+1,updated_at=now() RETURNING body,revision,{TIME}"),
            &[&text],
        )
        .await;
    match row {
        Ok(r) => {
            let appended = if r.get::<_, String>(0) == text { text.to_owned() } else { format!("\n{text}") };
            Ok(json!({"revision": r.get::<_, i32>(1), "updatedAt": r.get::<_, String>(2), "appended": appended}))
        }
        Err(e) if e.as_db_error().is_some_and(|d| d.code().code() == "23514") => Ok(json!({"tooLarge": true})),
        Err(e) => Err(e.into()),
    }
}

pub async fn settings(cx: &DataContext, p: &Value) -> Result<Value> {
    let sync = p["syncToNotes"].as_bool();
    let shortcut = p["shortcut"].as_str();
    if sync == Some(true) && !cx.db().query_one(NOTES_FOLDER, &[]).await?.get::<_, bool>(0) {
        return Ok(json!({"notesFolderMissing": true}));
    }
    // A change that names a field sets it. A field left out keeps its stored value.
    let row = cx
        .db()
        .query_one(
            &format!("INSERT INTO app.scratchpads(user_id,body,revision,sync_to_notes,shortcut,updated_at) \
             VALUES(app.current_actor_user_id(),'',1,COALESCE($1::boolean,false),COALESCE($2::text,'{DEFAULT_SHORTCUT}'),now()) \
             ON CONFLICT(user_id) DO UPDATE SET sync_to_notes=COALESCE($1::boolean,app.scratchpads.sync_to_notes), \
             shortcut=COALESCE($2::text,app.scratchpads.shortcut),updated_at=now() RETURNING sync_to_notes,shortcut"),
            &[&sync, &shortcut],
        )
        .await?;
    Ok(json!({"syncToNotes": row.get::<_, bool>(0), "shortcut": row.get::<_, String>(1)}))
}
