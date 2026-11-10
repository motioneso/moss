use super::*;
use moss_tasks_module::repository::{LISTS, TAGS};
use std::sync::Mutex;

// A synthetic provider records only this test's vocabulary. Real typed queries,
// RLS, account context and the compiled guest remain in the path.
struct SearchProvider {
    next: Arc<dyn Ports>,
    list: String,
    tag: String,
    prompt: Mutex<String>,
}
impl Ports for SearchProvider {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port == "ai" {
            assert_eq!(request.operation, "generate");
            assert_eq!(request.resource, "chat");
            *self.prompt.lock().unwrap() = request.parameters["prompt"].as_str().unwrap().into();
            return Ok(
                json!({"text":json!({"listIds":[self.list],"tagNames":[self.tag]}).to_string()}),
            );
        }
        let mut request = request.clone();
        if port == "db" && request.operation == "query" {
            let column = match request.resource.as_str() {
                LISTS => Some("id"),
                TAGS => Some("list_id"),
                _ => None,
            };
            if let Some(column) = column {
                let mut query: Query = serde_json::from_value(request.parameters)?;
                assert_eq!(query.kind, moss_module_sdk::query::Kind::Select);
                // Keep removal probes bounded to this test's synthetic list.
                query.filter = Filter::And {
                    filters: vec![query.filter, Filter::eq(column, self.list.as_str())],
                };
                request.parameters = serde_json::to_value(query)?;
            }
        }
        self.next.invoke(scope, port, &request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_search_hides_private_vocabulary_and_rejects_foreign_filters() {
    let mut f = Fixture::open_with(true);
    let name = format!("Private search list {}", Uuid::new_v4());
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":name}));
    let list = list["body"]["list"]["id"].as_str().unwrap().to_owned();
    let tag = format!("private-search-tag-{}", Uuid::new_v4());
    assert_eq!(
        f.route(
            f.owner,
            "POST",
            &format!("/tasks/lists/{list}/tags"),
            json!({"name":tag})
        )["status"],
        201
    );
    let provider = Arc::new(SearchProvider {
        next: f.ports.clone(),
        list: list.clone(),
        tag: tag.clone(),
        prompt: Mutex::new(String::new()),
    });
    f.ports = provider.clone();
    let search = |actor| {
        f.route(
            actor,
            "POST",
            "/tasks/search/interpret",
            json!({"query":"important work"}),
        )
    };
    let owner = search(f.owner);
    assert_eq!(owner["status"], 200);
    assert_eq!(owner["body"]["intent"]["listIds"], json!([list]));
    assert_eq!(owner["body"]["intent"]["tagNames"], json!([tag]));
    let assert_private = |actor| {
        let response = search(actor);
        assert_eq!(response["status"], 200);
        let prompt = provider.prompt.lock().unwrap();
        assert!(
            !prompt.contains(&name),
            "another account's list name must not reach AI"
        );
        assert!(
            !prompt.contains(&tag),
            "another account's tag name must not reach AI"
        );
        assert_eq!(response["body"]["intent"]["listIds"], json!([]));
        assert_eq!(response["body"]["intent"]["tagNames"], json!([]));
    };
    for actor in [f.other, f.admin] {
        assert_private(actor);
    }
    f.sql("ALTER TABLE app.task_lists DISABLE ROW LEVEL SECURITY; ALTER TABLE app.task_tags DISABLE ROW LEVEL SECURITY");
    let failure =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_private(f.other)));
    f.sql("ALTER TABLE app.task_lists ENABLE ROW LEVEL SECURITY; ALTER TABLE app.task_lists FORCE ROW LEVEL SECURITY; ALTER TABLE app.task_tags ENABLE ROW LEVEL SECURITY; ALTER TABLE app.task_tags FORCE ROW LEVEL SECURITY");
    // The expected assertion panic held the prompt lock; recover its synthetic contents.
    provider.prompt.clear_poison();
    let failure =
        failure.expect_err("the identical prompt privacy assertion must fail without RLS");
    let message = failure
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| failure.downcast_ref::<String>().map(String::as_str));
    assert_eq!(
        message,
        Some("another account's list name must not reach AI"),
        "an unrelated route, fuel or lock failure is not a privacy removal proof"
    );
    for actor in [f.other, f.admin] {
        assert_private(actor);
    }
    println!("PASS compiled search: private list/tag vocabulary and foreign filters hidden from ordinary/admin accounts; identical assertion fails without RLS and passes after restoration");
}

// Freeze only the invocation clock; account-local conversion still uses the real
// host, saved preferences, RLS and the compiled Tasks guest.
struct SearchClock {
    next: Arc<dyn Ports>,
}
impl Ports for SearchClock {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port == "context" && r.operation == "read" {
            return Ok(json!({"now":"2026-11-09T00:30:00.000Z"}));
        }
        self.next.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_search_uses_saved_account_day_in_prompt() {
    let mut f = Fixture::open_with(true);
    let provider = Arc::new(SearchProvider {
        next: Arc::new(SearchClock {
            next: f.ports.clone(),
        }),
        list: Uuid::new_v4().to_string(),
        tag: "synthetic".into(),
        prompt: Mutex::new(String::new()),
    });
    f.ports = provider.clone();
    // Give the independent account an explicit zone, distinct from the legacy
    // Pacific fallback, so this assertion actually tests account isolation.
    f.rt.block_on(f.db.execute(
        "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale',$2)",
        &[&f.other, &json!({"timezone":"UTC"})],
    ))
    .unwrap();
    for (zone, day) in [
        ("America/Los_Angeles", "2026-11-08"),
        ("Pacific/Kiritimati", "2026-11-09"),
        ("Invalid/Zone", "2026-11-08"),
    ] {
        f.rt.block_on(f.db.execute(
            "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale',$2) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json",
            &[&f.owner, &json!({"timezone":zone})]
        )).unwrap();
        let response = f.route(
            f.owner,
            "POST",
            "/tasks/search/interpret",
            json!({"query":"due today"}),
        );
        assert_eq!(response["status"], 200);
        assert!(
            provider
                .prompt
                .lock()
                .unwrap()
                .contains(&format!("Today in the user's locale: {day}.")),
            "search must use the saved account day for {zone}"
        );
        let calendar = f.route(f.owner, "GET", "/tasks/local-day", Value::Null);
        assert_eq!(calendar["status"], 200);
        assert_eq!(calendar["body"]["date"], day);
        assert_eq!(
            calendar["body"]["timezone"],
            if zone == "Invalid/Zone" {
                "America/Los_Angeles"
            } else {
                zone
            }
        );
        // Another account sees its own saved UTC zone.
        let other = f.route(f.other, "GET", "/tasks/local-day", Value::Null);
        assert_eq!(other["body"], json!({"timezone":"UTC","date":"2026-11-09"}));
    }
    println!("PASS compiled search/account calendar: saved local day, opposite UTC boundaries, invalid-zone fallback and independent accounts");
}
