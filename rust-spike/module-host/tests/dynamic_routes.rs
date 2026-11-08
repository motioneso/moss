use moss_module_host::{dispatch::resolve, manifest::Route};
use serde_json::json;
fn route(method: &str, path: &str) -> Route {
    Route {
        method: method.into(),
        path: path.into(),
        sign_in: true,
    }
}
#[test]
fn dynamic_routes_decode_params_and_repeated_query_values() {
    let r = resolve(
        &[route("GET", "/tasks/:id")],
        "GET",
        "/tasks/one%2Dtwo?tag=a&tag=b&search=hello+world",
    )
    .unwrap();
    assert_eq!(r.path, "/tasks/:id");
    assert_eq!(r.params["id"], "one-two");
    assert_eq!(r.query["tag"], json!(["a", "b"]));
    assert_eq!(r.query["search"], "hello world");
}
#[test]
fn exact_route_wins_and_ambiguous_templates_fail_closed() {
    let routes = [route("GET", "/tasks/:id"), route("GET", "/tasks/search")];
    assert_eq!(
        resolve(&routes, "GET", "/tasks/search").unwrap().path,
        "/tasks/search"
    );
    assert!(resolve(
        &[route("GET", "/tasks/:id"), route("GET", "/tasks/:other")],
        "GET",
        "/tasks/one"
    )
    .is_err());
    for path in [
        "/tasks/one%2Ftwo",
        "/tasks/%2e%2e",
        "/tasks/%00",
        "/tasks/%zz",
        "/tasks//",
        "/tasks/one#fragment",
    ] {
        assert!(resolve(&routes, "GET", path).is_err(), "{path}");
    }
    assert!(resolve(&routes, "POST", "/tasks/one").is_err());
}
#[test]
fn templates_are_explicit_and_use_safe_unique_parameter_names() {
    use moss_module_host::dispatch::template_path;
    assert!(template_path("/tasks/:id/activity"));
    for p in [
        "/tasks/:id/:id",
        "/tasks/:actorUserId",
        "/tasks/*rest",
        "/tasks/:",
        "/tasks/:id/..",
    ] {
        assert!(!template_path(p), "{p}");
    }
}
