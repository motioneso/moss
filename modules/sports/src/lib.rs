//! Sports package: followed leagues and teams, the standings picker's saved choices, and
//! account export. All effects cross the guest-safe SDK Host interface.
pub mod catalog;
mod catalog_table;
pub mod datasets;
pub mod eastern;
pub mod espn;
pub mod espn_games;
pub mod espn_schedule;
pub mod espn_standings;
pub mod followed;
pub mod follows;
pub mod identity;
pub mod input;
pub mod lifecycle;
pub mod overview;
pub mod public_cache;
pub mod public_routes;
pub mod results;
pub mod roster;
pub mod standings;
pub mod standings_views;
pub mod teams;
pub mod util;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};
use teams::TeamList;

/// Routes use the module-relative path template. A host failure leaves as a fixed message,
/// because host errors can carry request text.
pub fn route_with<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/follows") => follows::list(host),
        ("POST", "/follows") => follows::create(host, teams, &request),
        ("POST", "/follows/:id/team") => follows::choose_team(host, teams, &request),
        ("DELETE", "/follows/:id") => follows::remove(host, &request),
        ("GET", "/catalog") => Ok(Response::new(200, catalog::response())),
        ("GET", "/leagues/:competition_key/teams") => public_routes::league_teams(host, &request),
        ("GET", "/teams/search") => public_routes::search(host, &request),
        ("GET", "/standings-preferences") => standings::get(host),
        ("PUT", "/standings-preferences") => standings::put(host, &request),
        ("GET", "/overview") => overview::overview(host),
        ("GET", "/standings") => overview::standings(host, &request),
        ("GET", "/results/latest") => results::latest(host, &request),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"message":"Internal server error"})))
}

/// The packaged routes, reading team lists from ESPN.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    route_with(host, &roster::EspnTeams(host), request)
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(host: &H, kind: &str, payload: &str) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route(host, request))?)
        }
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Sports invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "collectSportsSourcesExportSection")]
        Export(#[allow(dead_code)] Value),
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Export(_) => json!({"ok":lifecycle::collect(host)?}),
    }
    .to_string())
}
