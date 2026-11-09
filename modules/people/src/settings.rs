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
        locale_compare(
            a["name"].as_str().unwrap_or(""),
            b["name"].as_str().unwrap_or(""),
        )
    });
    Ok(Response::new(
        200,
        json!({"path":if path.is_empty(){None}else{Some(path)},"directories":directories}),
    ))
}

// The legacy listing sorts with JavaScript localeCompare. It orders letters
// by their base letter first, then by accent, then by case, and it puts
// punctuation before digits and digits before letters.
pub(crate) fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let primary = |s: &str| {
        s.chars()
            .map(|c| {
                let (base, _) = base_letter(c);
                if base.is_ascii_digit() {
                    (1, base)
                } else if base.is_alphabetic() {
                    (2, base.to_lowercase().next().unwrap_or(base))
                } else {
                    (0, c)
                }
            })
            .collect::<Vec<_>>()
    };
    primary(a)
        .cmp(&primary(b))
        .then_with(|| {
            a.chars()
                .map(|c| base_letter(c).1)
                .cmp(b.chars().map(|c| base_letter(c).1))
        })
        .then_with(|| {
            a.chars()
                .map(|c| c.is_uppercase())
                .cmp(b.chars().map(|c| c.is_uppercase()))
        })
        .then_with(|| a.cmp(b))
        .then(Ordering::Equal)
}

// Returns the unaccented base letter and an accent rank where plain is zero.
fn base_letter(c: char) -> (char, u8) {
    let (base, rank) = match c {
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => ('A', 1),
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => ('a', 1),
        'Ç' | 'Ć' | 'Ĉ' | 'Ċ' | 'Č' => ('C', 1),
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => ('c', 1),
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ĕ' | 'Ė' | 'Ę' | 'Ě' => ('E', 1),
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => ('e', 1),
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' | 'Ĭ' | 'Į' | 'İ' => ('I', 1),
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ĭ' | 'į' | 'ı' => ('i', 1),
        'Ñ' | 'Ń' | 'Ň' => ('N', 1),
        'ñ' | 'ń' | 'ň' => ('n', 1),
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ō' | 'Ŏ' | 'Ő' => ('O', 1),
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' | 'ŏ' | 'ő' => ('o', 1),
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ŭ' | 'Ů' | 'Ű' | 'Ų' => ('U', 1),
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => ('u', 1),
        'Ý' | 'Þ' => ('Y', 1),
        'ý' | 'ÿ' | 'þ' => ('y', 1),
        'Š' | 'Ŝ' | 'Ş' => ('S', 1),
        'š' | 'ŝ' | 'ş' => ('s', 1),
        'Ž' | 'Ź' | 'Ż' => ('Z', 1),
        'ž' | 'ź' | 'ż' => ('z', 1),
        'Ğ' | 'Ĝ' | 'Ġ' | 'Ģ' => ('G', 1),
        'ğ' | 'ĝ' | 'ġ' | 'ģ' => ('g', 1),
        'Ĥ' | 'Ħ' => ('H', 1),
        'ĥ' | 'ħ' => ('h', 1),
        'Ĵ' => ('J', 1),
        'ĵ' => ('j', 1),
        'Ķ' => ('K', 1),
        'ķ' => ('k', 1),
        'Ĺ' | 'Ļ' | 'Ľ' | 'Ŀ' | 'Ł' => ('L', 1),
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => ('l', 1),
        'Ŕ' | 'Ŗ' | 'Ř' => ('R', 1),
        'ŕ' | 'ŗ' | 'ř' => ('r', 1),
        'Ť' | 'Ţ' | 'Ŧ' => ('T', 1),
        'ť' | 'ţ' | 'ŧ' => ('t', 1),
        'Ď' | 'Đ' => ('D', 1),
        'ď' | 'đ' => ('d', 1),
        _ => (c, 0),
    };
    (base, rank)
}

#[cfg(test)]
mod tests {
    use super::locale_compare;
    use std::cmp::Ordering;

    #[test]
    fn directory_order_matches_legacy_locale_order() {
        let mut names = [
            "Banana", "apple", "Ábc", "abd", "a10", "a2", "Zebra", "éclair", "zebra", "Apple",
            "apple2", "_x", "10x", "2x",
        ];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            names,
            [
                "_x", "10x", "2x", "a10", "a2", "Ábc", "abd", "apple", "Apple", "apple2", "Banana",
                "éclair", "zebra", "Zebra"
            ]
        );
        assert_eq!(locale_compare("Family", "Work"), Ordering::Less);
    }
}
