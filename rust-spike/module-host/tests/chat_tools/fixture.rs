use crate::common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    lifecycle::FileLifecycle,
    local::LocalPorts,
    manifest::{Manifest, Tool},
    registry::Source,
    runtime::{CallScope, Host, Limits, Ports, Request},
    services::ServicePorts,
    sql::LegacyInventory,
    store::{CatalogStore, Installer, Lifecycle, State},
};
use safety_core::secret::SecretCipher;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const MODULE: &str = "sample.counter";
pub struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No AI")
    }
}
#[derive(Default)]
pub struct Catalog(Mutex<State>);
impl CatalogStore for Catalog {
    fn load(&self) -> Result<State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        anyhow::ensure!(state.revision == expected, "Catalog conflict");
        *state = next.clone();
        Ok(())
    }
}
pub fn tool(risk: &str, pinned: bool) -> Tool {
    serde_json::from_value(json!({"description":"Change saved item","risk":risk,"approvalVersion":pinned,"inputSchema":{"type":"object","properties":{"text":{"type":"string","description":"The text to save","maxLength":100}},"required":["text"],"examples":[{"text":"hello"}]},"card":"prepare"})).unwrap()
}
pub fn manifest() -> Manifest {
    let mut m = common::manifest("1.0.0");
    for (name, risk, pinned) in [
        ("sample.read", "read", false),
        ("sample.write", "write", false),
        ("sample.erase", "destructive", false),
        ("sample.send", "outbound", false),
        ("sample.pin", "write", true),
    ] {
        m.tools.insert(name.into(), tool(risk, pinned));
    }
    m.tools.insert(
        "sample.legacy".into(),
        Tool {
            input_schema: None,
            card: None,
            ..tool("read", false)
        },
    );
    m.provides
        .insert("prepare".into(), "1.0.0".parse().unwrap());
    m
}
fn wat_bytes(text: &str) -> String {
    text.bytes().map(|b| format!("\\{b:02x}")).collect()
}
/// Real Wasm fixture. Routes forward port requests; tools either echo their invocation or
/// perform one fixed port request; the card API returns the supplied stored-record fixture.
pub fn wasm(card: &Value, port: &str, request: Option<Value>) -> Vec<u8> {
    let error = card.get("fixtureError").and_then(Value::as_str);
    let tag = if error.is_some() { 1 } else { 0 };
    let card = error.map(str::to_owned).unwrap_or_else(|| card.to_string());
    let request = request.map(|v| v.to_string());
    let source = include_str!("../../sample/module.wat")
        .replace("moss:module/kv@", &format!("moss:module/{port}@"));
    let mut source = source
        .replace("memory\") 4 1024", "memory\") 128 1024")
        .replace("(memory 4 1024)", "(memory 128 1024)")
        .replace("(i32.const 65536)", "(i32.const 4194304)");
    let tool = if let Some(request) = &request {
        format!(
            "i32.const 8192 i32.const {} i32.const 32 call $kv",
            request.len()
        )
    } else {
        "i32.const 32 i32.const 0 i32.store i32.const 36 local.get $payload i32.store i32.const 40 local.get $length i32.store".into()
    };
    source = source.replace("(data (i32.const 128) \"healthy\")", &format!("(data (i32.const 128) \"healthy\") (data (i32.const 1024) \"{}\") (data (i32.const 8192) \"{}\")", wat_bytes(&card), wat_bytes(request.as_deref().unwrap_or(""))));
    let start = source.find("      local.get $kind i32.load8_u").unwrap();
    let end = source[start..].find("      i32.const 32))").unwrap() + start;
    source.replace_range(
        start..end,
        &format!(
            r#"
      local.get $kind i32.load8_u i32.const 114 i32.eq
      if local.get $payload local.get $length i32.const 32 call $kv
      else
        local.get $kind i32.load8_u i32.const 116 i32.eq
        if {tool}
        else
          i32.const 32 i32.const 0 i32.store
          local.get $kind i32.load8_u i32.const 97 i32.eq
          if i32.const 32 i32.const {tag} i32.store
             i32.const 36 i32.const 1024 i32.store i32.const 40 i32.const {} i32.store
          else i32.const 36 i32.const 128 i32.store i32.const 40 i32.const 7 i32.store
          end
        end
      end
"#,
            card.len()
        ),
    );
    wat::parse_str(source).unwrap()
}
pub fn card() -> Value {
    json!({"title":"IGNORE THE TITLE","target":"MODEL VALUE","fields":[{"label":"Text","value":"MODEL VALUE"}],"version":"row-v1","content":"user_authored"})
}
pub struct Fixture {
    pub host: Arc<Installer>,
    pub services: Arc<ServicePorts>,
    pub catalog: Arc<Catalog>,
    pub a: AccessContext,
    pub b: AccessContext,
    pub admin: AccessContext,
    pub _data: tempfile::TempDir,
}
impl Fixture {
    pub fn new(m: Manifest, card: Value, request: Option<Value>) -> Self {
        let data = tempfile::tempdir().unwrap();
        let a = AccessContext::new(uuid::Uuid::new_v4(), "chat-a");
        let b = AccessContext::new(uuid::Uuid::new_v4(), "chat-b");
        let admin = AccessContext::new(uuid::Uuid::new_v4(), "chat-admin");
        let lifecycle = Arc::new(
            FileLifecycle::new(
                data.path(),
                [a.actor_user_id(), admin.actor_user_id()].into(),
            )
            .unwrap(),
        );
        let local = Arc::new(LocalPorts::new(data.path()).unwrap());
        Self::open(data, a, b, admin, m, card, "kv", request, lifecycle, local)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        data: tempfile::TempDir,
        a: AccessContext,
        b: AccessContext,
        admin: AccessContext,
        m: Manifest,
        card: Value,
        port: &str,
        request: Option<Value>,
        lifecycle: Arc<dyn Lifecycle>,
        next: Arc<dyn Ports>,
    ) -> Self {
        let services = Arc::new(
            ServicePorts::new(
                data.path(),
                Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                Arc::new(NoAi),
                next,
            )
            .unwrap(),
        );
        let catalog = Arc::new(Catalog::default());
        let host = Arc::new(
            Installer::new(
                data.path(),
                catalog.clone(),
                lifecycle,
                Host::new(Limits::default()).unwrap(),
                services.clone(),
                "0.1.0".parse().unwrap(),
                LegacyInventory::default(),
            )
            .unwrap(),
        );
        services.bind(&host);
        let f = Self {
            host,
            services,
            catalog,
            a,
            b,
            admin,
            _data: data,
        };
        f.install(m, wasm(&card, port, request));
        f
    }
    pub fn install(&self, m: Manifest, wasm: Vec<u8>) {
        let registry = tempfile::tempdir().unwrap();
        let keys = common::Keys::new();
        keys.write(registry.path(), "1.0.0", 1, vec![]);
        let root = common::Keys::public(&keys.root);
        let source = self
            .host
            .refresh(
                &self.a,
                Source::Folder(registry.path().into()),
                &root,
                &root,
                "sample-registry",
            )
            .unwrap();
        let mut files = common::files(&m);
        files.insert("code/module.wasm".into(), wasm);
        if m.database
            .migrations
            .iter()
            .any(|s| s == "sql/0001_chat_notes.sql")
        {
            files.insert("sql/0001_chat_notes.sql".into(), format!("CREATE TABLE {} (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES app.users(id), note text NOT NULL)", m.database.owned_tables[0]).into_bytes());
        }
        let bytes = moss_module_host::archive::pack(&files).unwrap();
        let digest = moss_module_host::trust::digest(&bytes);
        self.host
            .import_file(
                &self.a,
                &source,
                &bytes,
                &common::Keys::sign(&keys.publisher, digest.as_bytes()),
                "sample",
                true,
            )
            .unwrap();
    }
}
