//! Approval cards for News actions. Each card is built from what is stored for the person, never
//! from text the model supplied, and building one changes nothing. `{"ok": null}` means no card.
use crate::media;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Map, Value};

fn empty_object(json: Option<&str>) -> Option<Map<String, Value>> {
    match json {
        None => Some(Map::new()),
        Some(text) => match serde_json::from_str::<Value>(text).ok()? {
            Value::Object(map) => Some(map),
            _ => None,
        },
    }
}

fn card(title: &str, content: &str, target: &str, fields: Vec<Value>, version: String) -> Value {
    json!({"title": title, "content": content, "target": target, "fields": fields, "version": version})
}

/// The card for a chat tool. Only the refresh tool needs one, and only when it was given nothing.
fn tool_card(tool: &str, input_json: &str) -> Option<Value> {
    let input = empty_object(Some(input_json))?;
    (tool == "news.refreshNews" && input.is_empty())
        .then(|| card("Refresh news", "user_authored", "Your news feed", Vec::new(), "[]".into()))
}

pub fn prepare<H: Host + ?Sized>(_host: &H, tool: &str, input_json: &str) -> Value {
    json!({"ok": tool_card(tool, input_json)})
}

fn route_card<H: Host + ?Sized>(host: &H, route: &str, params: &Map<String, Value>) -> Result<Option<Value>> {
    let only = |key: &str| (params.len() == 1).then(|| params.get(key)?.as_str()).flatten();
    match route {
        "newsImage" => {
            let Some(id) = only("articleId") else { return Ok(None) };
            let Some(article) = media::image_article(host, id)? else { return Ok(None) };
            let url = article["imageUrl"].as_str().unwrap_or_default();
            let image_host = url.split("://").nth(1).and_then(|rest| rest.split(['/', '?', '#', ':']).next()).unwrap_or_default();
            Ok(Some(card(
                "Load story picture",
                "outside",
                article["headline"].as_str().unwrap_or_default(),
                vec![
                    json!({"label": "Publisher", "value": article["publisher"]}),
                    json!({"label": "Image host", "value": image_host}),
                ],
                article.to_string(),
            )))
        }
        "newsFavicon" => {
            let Some(domain) = only("domain") else { return Ok(None) };
            if !media::valid_hostname(domain) {
                return Ok(None);
            }
            let Some(label) = media::approved_publisher(host, domain)? else { return Ok(None) };
            Ok(Some(card(
                "Load publisher icon",
                "user_authored",
                &label,
                vec![json!({"label": "Publisher domain", "value": domain})],
                json!([domain, label]).to_string(),
            )))
        }
        _ => Ok(None),
    }
}

/// The card for a route: path parameters only, with no query and no body.
pub fn prepare_route<H: Host + ?Sized>(host: &H, route: &str, params: Option<&str>, query: Option<&str>, body: Option<&str>) -> Value {
    let (Some(params), Some(query), Some(body)) = (empty_object(params), empty_object(query), empty_object(body)) else {
        return json!({"ok": null});
    };
    if !query.is_empty() || !body.is_empty() {
        return json!({"ok": null});
    }
    match route_card(host, route, &params) {
        Ok(card) => json!({"ok": card}),
        Err(_) => json!({"error": {"statusCode": 503, "error": "News service is unavailable"}}),
    }
}
