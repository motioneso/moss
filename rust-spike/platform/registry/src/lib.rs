//! Manifest declarations remain queryable; boot coverage is checked in both directions.
use moss_platform_contracts::{module_id, Error};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)] pub navigation: Vec<Value>,
    #[serde(default)] pub settings: Vec<Value>,
    #[serde(default)] pub features: Vec<Value>,
    #[serde(default)] pub routes: Vec<Route>,
    #[serde(default)] pub database: Database,
    #[serde(flatten)] pub extensions: BTreeMap<String, Value>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    #[serde(default)] pub migrations: Vec<String>,
    #[serde(default)] pub migration_directories: Vec<String>,
    #[serde(default)] pub owned_tables: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Route {
    pub method: String,
    pub path: String,
    #[serde(flatten)] pub metadata: BTreeMap<String, Value>,
}
pub fn route_key(method: &str, path: &str) -> String {
    let method = method.to_uppercase();
    format!("{} {}", if method == "HEAD" { "GET" } else { &method }, path)
}
pub struct Registry {
    manifests: Vec<Manifest>,
    routes: BTreeMap<String, String>,
    tables: BTreeMap<String, String>,
}
impl Registry {
    pub fn load(manifests: Vec<Manifest>) -> Result<Self, Error> {
        let mut ids = BTreeSet::new();
        let mut routes = BTreeMap::new();
        let mut tables = BTreeMap::new();
        for m in &manifests {
            if !module_id(&m.id) || !ids.insert(m.id.clone()) { return Err(Error::InvalidDeclaration); }
            for route in &m.routes {
                if !matches!(route.method.to_uppercase().as_str(), "GET"|"HEAD"|"POST"|"PUT"|"PATCH"|"DELETE"|"OPTIONS") || !route.path.starts_with('/') || route.path.contains(['?', '#', '\\']) || route.path.split('/').any(|s| s == ".." || s == ".") { return Err(Error::InvalidDeclaration); }
                let key = route_key(&route.method, &route.path);
                if routes.get(&key).is_some_and(|owner| owner != &m.id) { return Err(Error::InvalidDeclaration); }
                routes.insert(key, m.id.clone());
            }
            for table in &m.database.owned_tables {
                if !table.starts_with("app.") || table[4..].is_empty() || !table[4..].bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_') || tables.insert(table.clone(),m.id.clone()).is_some() { return Err(Error::InvalidDeclaration); }
            }
            for path in m.database.migrations.iter().chain(&m.database.migration_directories) {
                if path.starts_with('/') || path.contains('\\') || path.split('/').any(|p| p == "..") { return Err(Error::InvalidDeclaration); }
            }
        }
        Ok(Self { manifests, routes, tables })
    }
    pub fn manifests(&self) -> &[Manifest] { &self.manifests }
    pub fn sql_owner(&self, table: &str) -> Option<&str> { self.tables.get(table).map(String::as_str) }
    pub fn route_owner(&self, method: &str, pattern: &str) -> Option<&str> { self.routes.get(&route_key(method,pattern)).map(String::as_str) }
    pub fn assert_coverage(&self, registered: &[Route], platform_allowlist: &BTreeSet<String>) -> Result<(), Error> {
        let actual: BTreeSet<_> = registered.iter().filter(|r| r.method.to_uppercase() != "OPTIONS").map(|r| route_key(&r.method,&r.path)).collect();
        if actual.iter().any(|key| !self.routes.contains_key(key) && !platform_allowlist.contains(key)) || self.routes.keys().any(|key| !actual.contains(key)) { return Err(Error::InvalidDeclaration); }
        Ok(())
    }
    pub fn app_map(&self, core: &Value, version: &str, build_id: &str, narrative: &str) -> Value {
        let core_array = |key: &str| core.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let core_screens = core_array("screens");
        let core_settings = core_array("settings");
        let mut screens: Vec<Value> = core_screens.iter().map(|v| owned(v,"core",None)).collect();
        let mut settings: Vec<Value> = core_settings.iter().map(|v| owned(v,"core",None)).collect();
        let mut features = vec![];
        let mut errors: Vec<Value> = core_array("errors").iter().map(|v| owned(v,"core",None)).collect();
        let mut remediations: Vec<Value> = core_array("remediations").iter().map(|v| owned(v,"core",None)).collect();
        for m in &self.manifests {
            screens.extend(m.navigation.iter().filter(|v| !duplicate(v,&core_screens)).map(|v| { let mut v=owned(v,&m.id,None); v["scope"]=json!("user"); v }));
            settings.extend(m.settings.iter().filter(|v| !duplicate(v,&core_settings)).map(|v| owned(v,&m.id,None)));
            for feature in &m.features {
                features.push(owned(feature,&m.id,None));
                for (key, target) in [("errors", &mut errors),("remediations", &mut remediations)] {
                    if let Some(values) = feature.get(key).and_then(Value::as_array) {
                        target.extend(values.iter().map(|v| owned(v,&m.id,feature.get("id"))));
                    }
                }
            }
        }
        json!({"schemaVersion":1,"build":{"version":version,"buildId":build_id},"screens":screens,"settings":settings,"features":features,"errors":errors,"remediations":remediations,"narrative":{"authoritative":false,"markdown":narrative}})
    }
}
fn duplicate(v: &Value, core: &[Value]) -> bool { core.iter().any(|c| c.get("id") == v.get("id") || c.get("path") == v.get("path")) }
fn owned(v: &Value, module: &str, feature: Option<&Value>) -> Value {
    let mut result = json!({"moduleId":module});
    if let Some(id) = feature { result["featureId"]=id.clone(); }
    if let Some(fields)=v.as_object() { result.as_object_mut().unwrap().extend(fields.clone()); }
    result
}
