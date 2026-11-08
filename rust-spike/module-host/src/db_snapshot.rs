//! Transactional database snapshots. Shadow tables never retain defaults referencing live
//! serial sequences. Restore copies non-generated columns and reinstates the captured policy.
use crate::{
    database::owner_role,
    migrations::{provision_roles, PostgresLifecycle},
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
fn q(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn table_name(table: &str) -> Result<&str> {
    let name = table
        .strip_prefix("app.")
        .context("Invalid snapshot table")?;
    ensure!(
        !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
        "Invalid snapshot table"
    );
    Ok(name)
}
impl PostgresLifecycle {
    pub(crate) fn snapshot_database(&self, id: &str, snapshot: &str) -> Result<Value> {
        self.runtime.block_on(async {
            let mut client=self.privileged().await?;let tx=client.transaction().await?;
            let schema=format!("moss_snapshot_{}",snapshot.replace('-',""));
            tx.batch_execute(&format!("CREATE SCHEMA {schema}; REVOKE ALL ON SCHEMA {schema} FROM PUBLIC")).await?;
            let owned:Vec<String>=tx.query("SELECT name FROM moss_modules.owned_tables WHERE module_id=$1 ORDER BY name",&[&id]).await?.iter().map(|r|r.get(0)).collect();
            if !owned.is_empty(){tx.batch_execute(&format!("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE",owned.join(","))).await?;}
            let mut tables=serde_json::Map::new();
            for table in &owned {
                let name=table_name(table)?;
                let meta=tx.query_one("SELECT pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::text::regclass",&[table]).await?;
                let columns:Vec<String>=tx.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::text::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum",&[table]).await?.iter().map(|r|q(&r.get::<_,String>(0))).collect();
                let columns=columns.join(",");
                tx.batch_execute(&format!("CREATE TABLE {schema}.{name} (LIKE {table} INCLUDING ALL)")).await?;
                let mut sequences=Vec::new();
                for row in tx.query("SELECT attname,attidentity::text,pg_get_serial_sequence($1,attname) FROM pg_attribute WHERE attrelid=$1::text::regclass AND attnum>0 AND NOT attisdropped",&[table]).await? {
                    let column:String=row.get(0);let identity:String=row.get(1);
                    if let Some(seq)=row.get::<_,Option<String>>(2) {
                        let definition=tx.query_one("SELECT seqstart,seqincrement,seqmax,seqmin,seqcache,seqcycle,format_type(seqtypid,NULL) FROM pg_sequence WHERE seqrelid=$1::text::regclass",&[&seq]).await?;
                        let state=tx.query_one(&format!("SELECT last_value,is_called FROM {seq}"),&[]).await?;
                        sequences.push(json!({"column":column,"identity":identity,"name":seq,"last":state.get::<_,i64>(0),"called":state.get::<_,bool>(1),"start":definition.get::<_,i64>(0),"increment":definition.get::<_,i64>(1),"max":definition.get::<_,i64>(2),"min":definition.get::<_,i64>(3),"cache":definition.get::<_,i64>(4),"cycle":definition.get::<_,bool>(5),"type":definition.get::<_,String>(6)}));
                        if identity.is_empty(){tx.batch_execute(&format!("ALTER TABLE {schema}.{name} ALTER COLUMN {} DROP DEFAULT",q(&column))).await?;}
                    }
                }
                tx.batch_execute(&format!("INSERT INTO {schema}.{name} ({columns}) OVERRIDING SYSTEM VALUE SELECT {columns} FROM {table}")).await?;
                let fks:Vec<Value>=tx.query("SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=$1::text::regclass AND contype='f'",&[table]).await?.iter().map(|r|json!({"name":r.get::<_,String>(0),"definition":r.get::<_,String>(1)})).collect();
                let policies:Vec<Value>=tx.query("SELECT policyname,permissive,roles::text[],cmd,qual,with_check FROM pg_policies WHERE schemaname='app' AND tablename=$1",&[&name]).await?.iter().map(|r|json!({"name":r.get::<_,String>(0),"permissive":r.get::<_,String>(1),"roles":r.get::<_,Vec<String>>(2),"command":r.get::<_,String>(3),"using":r.get::<_,Option<String>>(4),"check":r.get::<_,Option<String>>(5)})).collect();
                let triggers:Vec<String>=tx.query("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid=$1::text::regclass AND NOT tgisinternal",&[table]).await?.iter().map(|r|r.get(0)).collect();
                let grants:Vec<Value>=tx.query("SELECT grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='app' AND table_name=$1",&[&name]).await?.iter().map(|r|json!({"role":r.get::<_,String>(0),"privilege":r.get::<_,String>(1)})).collect();
                tables.insert(table.clone(),json!({"columns":columns,"owner":meta.get::<_,String>(0),"rls":meta.get::<_,bool>(1),"force":meta.get::<_,bool>(2),"sequences":sequences,"foreignKeys":fks,"policies":policies,"triggers":triggers,"grants":grants}));
            }
            let ledger:Vec<Value>=tx.query("SELECT path,checksum FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await?.iter().map(|r|json!({"path":r.get::<_,String>(0),"checksum":r.get::<_,String>(1)})).collect();
            // Capture the historical ledgers too. Recovery only changes versions owned by
            // this module, never unrelated core entries.
            let core:Vec<Value>=tx.query("SELECT version,name,checksum FROM app.schema_migrations",&[]).await?.iter().filter(|r|crate::legacy::entry(id,&format!("sql/{}",r.get::<_,String>(1))).is_some()||ledger.iter().any(|l|l["path"].as_str()==Some(&format!("sql/{}",r.get::<_,String>(1))))).map(|r|json!({"version":r.get::<_,String>(0),"name":r.get::<_,String>(1),"checksum":r.get::<_,String>(2)})).collect();
            let module:Vec<Value>=tx.query("SELECT version,name,checksum FROM app.module_schema_migrations WHERE module_id=$1",&[&id]).await?.iter().map(|r|json!({"version":r.get::<_,String>(0),"name":r.get::<_,String>(1),"checksum":r.get::<_,String>(2)})).collect();
            let key=crate::jobs::module_key(id);
            let jobs:Vec<Value>=tx.query("SELECT to_jsonb(j) FROM moss_queue.jobs j WHERE payload->>'moduleId'=$1",&[&key]).await?.iter().map(|r|r.get(0)).collect();
            let schedules:Vec<Value>=tx.query("SELECT to_jsonb(s) FROM moss_queue.schedules s WHERE payload->>'moduleId'=$1",&[&key]).await?.iter().map(|r|r.get(0)).collect();
            tx.commit().await?;
            Ok(json!({"schema":schema,"tables":tables,"ledger":ledger,"core":core,"module":module,"jobs":jobs,"schedules":schedules}))
        })
    }
    pub(crate) fn restore_database(&self, id: &str, snapshot: &str, data: &Value) -> Result<()> {
        self.runtime.block_on(async {
            let mut client=self.privileged().await?;let tx=client.transaction().await?;
            let tables=data["tables"].as_object().context("Invalid database snapshot")?;
            let schema=data["schema"].as_str().context("Missing snapshot schema")?;
            ensure!(schema==format!("moss_snapshot_{}",snapshot.replace('-',"")),"Invalid snapshot schema");
            let current:Vec<String>=tx.query("SELECT name FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?.iter().map(|r|r.get(0)).collect();
            if !current.is_empty(){tx.batch_execute(&format!("DROP TABLE {}",current.join(","))).await?;}
            provision_roles(&tx,id).await?;
            for (table,meta) in tables {
                let name=table_name(table)?;let owner=meta["owner"].as_str().context("Missing table owner")?;
                ensure!(owner==owner_role(id)||(owner=="jarvis_migration_owner"&&crate::legacy::owns(id,table)),"Snapshot owner mismatch");
                let columns=meta["columns"].as_str().context("Missing columns")?;
                tx.batch_execute(&format!("CREATE TABLE {table} (LIKE {schema}.{name} INCLUDING ALL); INSERT INTO {table} ({columns}) OVERRIDING SYSTEM VALUE SELECT {columns} FROM {schema}.{name}; ALTER TABLE {table} OWNER TO {}",q(owner))).await?;
                for seq in meta["sequences"].as_array().context("Missing sequences")? {
                    let col=seq["column"].as_str().context("Missing sequence column")?;
                    let target=if seq["identity"]=="" {
                        let target=seq["name"].as_str().context("Missing sequence name")?;
                        let kind=seq["type"].as_str().context("Missing sequence type")?;
                        ensure!(matches!(kind,"smallint"|"integer"|"bigint"),"Invalid sequence type");
                        tx.batch_execute(&format!("CREATE SEQUENCE {target} AS {kind} INCREMENT {} MINVALUE {} MAXVALUE {} START {} CACHE {} {}; ALTER SEQUENCE {target} OWNER TO {}; ALTER SEQUENCE {target} OWNED BY {table}.{}; ALTER TABLE {table} ALTER COLUMN {} SET DEFAULT nextval('{target}'::regclass)",seq["increment"],seq["min"],seq["max"],seq["start"],seq["cache"],if seq["cycle"]==true{"CYCLE"}else{"NO CYCLE"},q(owner),q(col),q(col))).await?;
                        target.to_string()
                    }else{tx.query_one("SELECT pg_get_serial_sequence($1,$2)",&[table,&col]).await?.get(0)};
                    let last=seq["last"].as_i64().context("Missing sequence position")?;let called=seq["called"].as_bool().context("Missing sequence state")?;
                    tx.query_one("SELECT setval($1::text::regclass,$2,$3)",&[&target,&last,&called]).await?;
                    tx.batch_execute(&format!("GRANT USAGE,SELECT ON SEQUENCE {target} TO {}",crate::database::runtime_role(id))).await?;
                }
                for policy in meta["policies"].as_array().context("Missing policies")? {
                    let roles=policy["roles"].as_array().context("Missing policy roles")?.iter().map(|r|r.as_str().map(|r|if r=="public"{"PUBLIC".into()}else{q(r)}).context("Invalid policy role")).collect::<Result<Vec<_>>>()?.join(",");
                    let using=policy["using"].as_str().map(|s|format!("USING ({s})")).unwrap_or_default();let check=policy["check"].as_str().map(|s|format!("WITH CHECK ({s})")).unwrap_or_default();
                    tx.batch_execute(&format!("CREATE POLICY {} ON {table} AS {} FOR {} TO {roles} {using} {check}",q(policy["name"].as_str().context("Missing policy name")?),policy["permissive"].as_str().context("Missing policy mode")?,policy["command"].as_str().context("Missing policy command")?)).await?;
                }
                if meta["rls"]==true {tx.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")).await?;}
                if meta["force"]==true {tx.batch_execute(&format!("ALTER TABLE {table} FORCE ROW LEVEL SECURITY")).await?;}
                for grant in meta["grants"].as_array().context("Missing grants")? {
                    let privilege=grant["privilege"].as_str().context("Missing privilege")?;ensure!(["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER","MAINTAIN"].contains(&privilege),"Invalid snapshot privilege");
                    let role=grant["role"].as_str().context("Missing grantee")?;
                    tx.batch_execute(&format!("GRANT {privilege} ON {table} TO {}",if role=="PUBLIC"{"PUBLIC".into()}else{q(role)})).await?;
                }
            }
            for (table,meta) in tables {
                for key in meta["foreignKeys"].as_array().context("Missing foreign keys")? {tx.batch_execute(&format!("ALTER TABLE {table} ADD CONSTRAINT {} {}",q(key["name"].as_str().context("Missing constraint name")?),key["definition"].as_str().context("Missing constraint definition")?)).await?;}
                for trigger in meta["triggers"].as_array().context("Missing triggers")? {tx.batch_execute(trigger.as_str().context("Invalid trigger")?).await?;}
            }
            let before:Vec<String>=tx.query("SELECT path FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await?.iter().map(|r|r.get(0)).collect();
            for path in before {if data["ledger"].as_array().context("Missing ledger")?.iter().all(|r|r["path"]!=path){let version=crate::legacy::version(&path)?;tx.execute("DELETE FROM app.schema_migrations WHERE version=$1 AND name=$2",&[&version,&&path[4..]]).await?;}}
            tx.execute("DELETE FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?;
            for table in tables.keys(){tx.execute("INSERT INTO moss_modules.owned_tables(module_id,name) VALUES($1,$2)",&[&id,table]).await?;}
            tx.execute("DELETE FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await?;
            for row in data["ledger"].as_array().context("Missing ledger")? {tx.execute("INSERT INTO moss_modules.migrations(module_id,path,checksum) VALUES($1,$2,$3)",&[&id,&row["path"].as_str().context("Missing path")?,&row["checksum"].as_str().context("Missing checksum")?]).await?;}
            tx.execute("DELETE FROM app.module_schema_migrations WHERE module_id=$1",&[&id]).await?;
            for row in data["module"].as_array().context("Missing module ledger")? {tx.execute("INSERT INTO app.module_schema_migrations(module_id,version,name,checksum) VALUES($1,$2,$3,$4)",&[&id,&row["version"].as_str().context("Missing version")?,&row["name"].as_str().context("Missing name")?,&row["checksum"].as_str().context("Missing checksum")?]).await?;}
            let key=crate::jobs::module_key(id);
            tx.execute("DELETE FROM moss_queue.schedules WHERE payload->>'moduleId'=$1",&[&key]).await?;
            tx.execute("DELETE FROM moss_queue.jobs WHERE payload->>'moduleId'=$1",&[&key]).await?;
            for (table,field) in [("moss_queue.jobs","jobs"),("moss_queue.schedules","schedules")] {
                for row in data[field].as_array().context("Missing queue snapshot")? {tx.execute(&format!("INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},$1)"),&[row]).await?;}
            }
            tx.commit().await?;Ok(())
        })
    }
}
