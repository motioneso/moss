//! Sports package: followed leagues and teams, the standings picker's saved choices, and
//! account export. All effects cross the guest-safe SDK Host interface.
pub mod article;
pub mod briefing;
pub mod catalog;
mod catalog_table;
pub mod datasets;
pub mod eastern;
pub mod espn_coverage;
pub mod espn;
pub mod espn_games;
pub mod espn_schedule;
pub mod espn_standings;
pub mod followed;
pub mod gameday;
pub mod follow_tools;
pub mod follows;
pub mod heartbeat;
pub mod identity;
pub mod input;
pub mod lifecycle;
pub mod news_scope;
pub mod overview;
pub mod photo;
pub mod photo_discovery;
pub mod photo_pass;
pub mod photo_routes;
pub mod photo_store;
pub mod public_cache;
pub mod public_routes;
pub mod recipe;
pub mod recipe_fetch;
pub mod recipe_propose;
pub mod results;
pub mod roster;
pub mod source_approval;
pub mod source_discovery;
pub mod source_icon;
pub mod source_input;
pub mod source_preview;
pub mod source_rebuild;
pub mod source_refresh;
pub mod source_routes;
pub mod source_scope;
pub mod source_tools;
pub mod source_web;
pub mod sources;
pub mod standings;
pub mod story;
pub mod standings_views;
pub mod teams;
pub mod tools;
pub mod chat;
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
        ("GET", "/sources") => source_routes::list(host),
        ("PUT", "/sources/espn/coverage") => source_routes::put_coverage(host, &request),
        ("POST", "/sources/preview") => source_routes::preview_new(host, teams, &request),
        ("POST", "/sources") => source_routes::confirm_new(host, &request),
        ("POST", "/sources/:id/assignments/preview") => source_routes::preview_assignments(host, teams, &request),
        ("PATCH", "/sources/:id/assignments") => source_routes::confirm_assignments(host, &request),
        ("POST", "/sources/:id/retry") => source_rebuild::retry(host, &request),
        ("POST", "/sources/:id/rebuild/preview") => source_rebuild::preview(host, teams, &request),
        ("PATCH", "/sources/:id/rebuild") => source_rebuild::confirm(host, &request),
        ("GET", "/sources/:id/icon") => source_icon::icon(host, &request),
        ("GET", "/headlines/:headline_id/photo") => photo_routes::photo(host, &request),
        ("DELETE", "/sources/:id/photos") => photo_routes::stop_photos(host, &request),
        ("DELETE", "/sources/:id") => source_routes::remove(host, &request),
        ("POST", "/tools/run") => source_tools::transport(host, &request.body),
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
        "tool" => Ok(serde_json::to_string(
            &tools::run(host, &roster::EspnTeams(host), payload)
                .map_err(|_| moss_module_sdk::Error::new("Sports tool failed"))?,
        )?),
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
        #[serde(rename = "prepareSportsSourceAction")]
        Prepare(Prepare),
        #[serde(rename = "prepareSportsChatAction")]
        Chat(Value),
        #[serde(rename = "sportsFollowedFactsToday")]
        Facts(Facts),
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Facts {
        time_zone: Option<String>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Prepare {
        tool: String,
        // A JSON string keeps the field order the card was asked for.
        input_json: String,
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Chat(p) => chat::prepare(host, &roster::EspnTeams(host), &p)?,
        Api::Export(_) => json!({"ok":lifecycle::collect(host)?}),
        Api::Prepare(p) => source_approval::prepare(host, &roster::EspnTeams(host), &p.tool, &p.input_json),
        Api::Facts(f) => briefing::today(host, f.time_zone.as_deref().unwrap_or("UTC")),
    }
    .to_string())
}
