//! Settings routes keep shared preferences in the host; no direct app.preferences access.
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::json;

pub fn route(host: &impl Host, request: &RouteRequest) -> Result<Option<Response>> {
    let (operation, resource, parameters) = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/people/notes-settings") => ("preference.read", "people-folder", json!({})),
        ("PUT", "/people/notes-settings") => {
            let Some(folder) = request
                .body
                .get("folder")
                .filter(|v| v.is_null() || v.is_string())
            else {
                return Ok(Some(Response::new(
                    400,
                    json!({"error":"Invalid folder setting"}),
                )));
            };
            // Fastify coerces null to an empty string before the legacy handler;
            // normalizeFolder rejects that path instead of clearing the preference.
            if folder.as_str() == Some("") {
                return Ok(Some(Response::new(
                    400,
                    json!({"error":"People notes folder is unavailable"}),
                )));
            }
            (
                "preference.write",
                "people-folder",
                json!({"folder":folder}),
            )
        }
        ("GET", "/people/note-folders") => {
            let path = request
                .query
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ("preference.folders", "people-folder", json!({"path":path}))
        }
        ("GET", "/people/notes-directories") => return directories(host, request).map(Some),
        ("GET", "/people/note-suggestions") => ("preference.read", "people-suggestions", json!({})),
        ("PUT", "/people/note-suggestions") => {
            let Some(enabled) = request.body.get("enabled").and_then(|v| v.as_bool()) else {
                return Ok(Some(Response::new(
                    400,
                    json!({"error":"Invalid note suggestion setting"}),
                )));
            };
            (
                "preference.write",
                "people-suggestions",
                json!({"enabled":enabled}),
            )
        }
        _ => return Ok(None),
    };
    // Folder-selection failures are safe, actionable errors. Reads/backend failures
    // use the ordinary central error path; never expose filesystem/database detail.
    let result = host.call("kv", operation, resource, parameters);
    if request.method == "PUT" && resource == "people-folder" && result.is_err() {
        return Ok(Some(Response::new(
            400,
            json!({"error":"People notes folder is unavailable"}),
        )));
    }
    Ok(Some(Response::new(200, result?)))
}

/// Orders directory names like the legacy `localeCompare` sort.
///
/// The first pass ignores case and folds common Latin accents to their base
/// letters. Later passes put unaccented letters first, then lowercase before
/// uppercase. Scripts without a fold entry keep code-point order, which can
/// differ from a full locale collation.
pub fn compare_directory_names(a: &str, b: &str) -> std::cmp::Ordering {
    let folded = |name: &str| {
        name.chars()
            .flat_map(|c| c.to_lowercase())
            .flat_map(fold_letter)
            .collect::<String>()
    };
    folded(a)
        .cmp(&folded(b))
        .then_with(|| accent_marks(a).cmp(&accent_marks(b)))
        .then_with(|| case_marks(a).cmp(&case_marks(b)))
        .then_with(|| a.cmp(b))
}

fn fold_letter(c: char) -> Vec<char> {
    let folded = match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' | 'ǎ' | 'ȁ' | 'ȃ' | 'ạ' | 'ả' | 'ấ'
        | 'ầ' | 'ẩ' | 'ẫ' | 'ậ' | 'ắ' | 'ằ' | 'ẳ' | 'ẵ' | 'ặ' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => "c",
        'ď' | 'đ' | 'ð' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' | 'ȅ' | 'ȇ' | 'ẹ' | 'ẻ' | 'ẽ' | 'ế'
        | 'ề' | 'ể' | 'ễ' | 'ệ' => "e",
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => "g",
        'ĥ' | 'ħ' => "h",
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' | 'ị' | 'ỉ' => "i",
        'ĵ' => "j",
        'ķ' => "k",
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => "l",
        'ñ' | 'ń' | 'ņ' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' | 'ǒ' | 'ȍ' | 'ȏ' | 'ọ' | 'ỏ' | 'ố'
        | 'ồ' | 'ổ' | 'ỗ' | 'ộ' | 'ớ' | 'ờ' | 'ở' | 'ỡ' | 'ợ' => "o",
        'œ' => "oe",
        'ŕ' | 'ŗ' | 'ř' => "r",
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => "s",
        'ß' => "ss",
        'ţ' | 'ť' | 'ŧ' | 'ț' => "t",
        'þ' => "th",
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' | 'ǔ' | 'ȕ' | 'ȗ' | 'ụ' | 'ủ'
        | 'ứ' | 'ừ' | 'ử' | 'ữ' | 'ự' => "u",
        'ý' | 'ÿ' | 'ŷ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        _ => return vec![c],
    };
    folded.chars().collect()
}

fn accent_marks(name: &str) -> Vec<bool> {
    name.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| fold_letter(c) != vec![c])
        .collect()
}

fn case_marks(name: &str) -> Vec<bool> {
    name.chars().map(|c| c.is_uppercase()).collect()
}

// Legacy browsing is relative to the selected People folder. The additive
// note-folders picker instead browses the account's allowed absolute roots.
fn directories(host: &impl Host, request: &RouteRequest) -> Result<Response> {
    let path = match request.query.get("path") {
        None => "",
        Some(serde_json::Value::String(path)) => path.trim_matches(crate::js_space),
        _ => return Err(moss_module_sdk::Error::new("Invalid directory query")),
    };
    let unavailable = || Response::new(400, json!({"error":"People notes folder is unavailable"}));
    if !host.call("vault", "notes.status", "people-notes", json!({}))?["available"]
        .as_bool()
        .unwrap_or(false)
    {
        return Ok(unavailable());
    }
    if path.starts_with(['/', '\\']) || path.split(['/', '\\']).any(|s| s == "..") {
        return Ok(unavailable());
    }
    let relative = path
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect::<Vec<_>>()
        .join("/");
    let Ok(value) = host.call(
        "vault",
        "notes.list",
        "people-notes",
        json!({"path":relative}),
    ) else {
        return Ok(unavailable());
    };
    let mut directories: Vec<_> = value["entries"].as_array().into_iter().flatten()
        .filter(|e| e["kind"] == "directory")
        .filter_map(|entry| entry["name"].as_str())
        .map(|name| json!({"name":name,"path":if relative.is_empty(){name.to_owned()}else{format!("{relative}/{name}")}}))
        .collect();
    directories.sort_by(|a, b| {
        compare_directory_names(
            a["name"].as_str().unwrap_or_default(),
            b["name"].as_str().unwrap_or_default(),
        )
    });
    Ok(Response::new(
        200,
        json!({"path":if path.is_empty(){None}else{Some(path)},"directories":directories}),
    ))
}
