//! Settings routes keep shared preferences in the host; no direct app.preferences access.
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::json;
use unicode_normalization::UnicodeNormalization;

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

// The legacy listing sorts with JavaScript localeCompare: punctuation in
// legacy collation order, then digits, then letters by base letter, accent
// and case. Special letters expand or follow their base letter.
pub(crate) fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    // localeCompare treats canonical Unicode spellings as equal. Normalize
    // comparison keys only: the folder name and path returned to clients stay exact.
    let a: String = a.nfc().collect();
    let b: String = b.nfc().collect();
    let keys = |s: &str| {
        let mut primary: Vec<(u8, u32)> = Vec::new();
        let mut secondary: Vec<u32> = Vec::new();
        for c in s.chars() {
            if let Some(rank) = combining_rank(c) {
                if let Some(last) = secondary.last_mut() {
                    *last = rank;
                }
                continue;
            }
            let (expansion, rank) = base_expansion(c);
            for (i, base) in expansion.chars().enumerate() {
                primary.push(primary_key(base));
                secondary.push(if i == 0 { rank } else { 0 });
            }
        }
        (primary, secondary)
    };
    let (primary_a, secondary_a) = keys(&a);
    let (primary_b, secondary_b) = keys(&b);
    primary_a
        .cmp(&primary_b)
        .then_with(|| secondary_a.cmp(&secondary_b))
        .then_with(|| {
            a.chars()
                .map(|c| c.is_uppercase())
                .cmp(b.chars().map(|c| c.is_uppercase()))
        })
        .then_with(|| a.cmp(&b))
}

fn primary_key(c: char) -> (u8, u32) {
    const PUNCTUATION: &str = " _-,;:!?.\"()[]{}§@*/\\&#%`^+<=>|~$";
    if c.is_ascii_digit() {
        (1, c as u32)
    } else if c.is_alphabetic() {
        (2, c.to_lowercase().next().unwrap_or(c) as u32)
    } else if let Some(index) = PUNCTUATION.chars().position(|p| p == c) {
        (0, index as u32)
    } else {
        (0, 1000 + c as u32)
    }
}

fn combining_rank(c: char) -> Option<u32> {
    Some(match c {
        '\u{301}' => 2,
        '\u{300}' => 3,
        '\u{306}' => 4,
        '\u{302}' => 5,
        '\u{30c}' => 6,
        '\u{30a}' => 7,
        '\u{308}' => 8,
        '\u{303}' => 9,
        '\u{307}' => 10,
        '\u{327}' => 11,
        '\u{328}' => 12,
        '\u{304}' => 13,
        '\u{30b}' => 14,
        '\u{300}'..='\u{36f}' => 15,
        _ => return None,
    })
}

// Returns the base letters a character sorts as, plus its accent rank.
// Plain letters rank zero and special letter forms rank one.
fn base_expansion(c: char) -> (String, u32) {
    let (expansion, rank) = match c {
        'Æ' | 'æ' => ("ae".to_owned(), 1),
        'Œ' | 'œ' => ("oe".to_owned(), 1),
        'ß' => ("ss".to_owned(), 1),
        'Ø' | 'ø' => ("o".to_owned(), 1),
        'Ð' | 'ð' => ("d".to_owned(), 1),
        'Ł' | 'ł' => ("l".to_owned(), 1),
        'Ħ' | 'ħ' => ("h".to_owned(), 1),
        'Ŋ' | 'ŋ' => ("n".to_owned(), 1),
        'ẞ' => ("ss".to_owned(), 1),
        'Đ' | 'đ' => ("d".to_owned(), 1),
        _ => {
            let (base, rank) = base_letter(c);
            (base.to_string(), rank)
        }
    };
    (expansion, rank)
}

fn base_letter(c: char) -> (char, u32) {
    // Accent ranks follow the legacy accent order: acute, grave, breve,
    // circumflex, caron, ring, diaeresis, tilde, dot, cedilla, ogonek,
    // macron, then double acute.
    match c {
        'À' | 'à' => ('a', 3),
        'Á' | 'á' => ('a', 2),
        'Â' | 'â' => ('a', 5),
        'Ã' | 'ã' => ('a', 9),
        'Ä' | 'ä' => ('a', 8),
        'Å' | 'å' => ('a', 7),
        'Ā' | 'ā' => ('a', 13),
        'Ă' | 'ă' => ('a', 4),
        'Ą' | 'ą' => ('a', 12),
        'Ç' | 'ç' => ('c', 11),
        'Ć' | 'ć' => ('c', 2),
        'Ĉ' | 'ĉ' => ('c', 5),
        'Ċ' | 'ċ' => ('c', 10),
        'Č' | 'č' => ('c', 6),
        'È' | 'è' => ('e', 3),
        'É' | 'é' => ('e', 2),
        'Ê' | 'ê' => ('e', 5),
        'Ë' | 'ë' => ('e', 8),
        'Ē' | 'ē' => ('e', 13),
        'Ĕ' | 'ĕ' => ('e', 4),
        'Ė' | 'ė' => ('e', 10),
        'Ę' | 'ę' => ('e', 12),
        'Ě' | 'ě' => ('e', 6),
        'Ì' | 'ì' => ('i', 3),
        'Í' | 'í' => ('i', 2),
        'Î' | 'î' => ('i', 5),
        'Ï' | 'ï' => ('i', 8),
        'Ī' | 'ī' => ('i', 13),
        'Ĭ' | 'ĭ' => ('i', 4),
        'Į' | 'į' => ('i', 12),
        'İ' => ('i', 10),
        'Ñ' | 'ñ' => ('n', 9),
        'Ń' | 'ń' => ('n', 2),
        'Ň' | 'ň' => ('n', 6),
        'Ò' | 'ò' => ('o', 3),
        'Ó' | 'ó' => ('o', 2),
        'Ô' | 'ô' => ('o', 5),
        'Õ' | 'õ' => ('o', 9),
        'Ö' | 'ö' => ('o', 8),
        'Ō' | 'ō' => ('o', 13),
        'Ŏ' | 'ŏ' => ('o', 4),
        'Ő' | 'ő' => ('o', 12),
        'Ù' | 'ù' => ('u', 3),
        'Ú' | 'ú' => ('u', 2),
        'Û' | 'û' => ('u', 5),
        'Ü' | 'ü' => ('u', 8),
        'Ū' | 'ū' => ('u', 13),
        'Ŭ' | 'ŭ' => ('u', 4),
        'Ů' | 'ů' => ('u', 7),
        'Ű' | 'ű' => ('u', 14),
        'Ų' | 'ų' => ('u', 12),
        'Ý' | 'ý' => ('y', 2),
        'Ÿ' | 'ÿ' => ('y', 8),
        'Š' | 'š' => ('s', 6),
        'Ŝ' | 'ŝ' => ('s', 5),
        'Ş' | 'ş' => ('s', 11),
        'Ž' | 'ž' => ('z', 6),
        'Ź' | 'ź' => ('z', 2),
        'Ż' | 'ż' => ('z', 10),
        'Ğ' | 'ğ' => ('g', 4),
        'Ĝ' | 'ĝ' => ('g', 5),
        'Ġ' | 'ġ' => ('g', 10),
        'Ģ' | 'ģ' => ('g', 11),
        'Ĥ' | 'ĥ' => ('h', 5),
        'Ĵ' | 'ĵ' => ('j', 5),
        'Ķ' | 'ķ' => ('k', 11),
        'Ĺ' | 'ĺ' => ('l', 2),
        'Ļ' | 'ļ' => ('l', 11),
        'Ľ' | 'ľ' => ('l', 6),
        'Ŀ' | 'ŀ' => ('l', 10),
        'Ŕ' | 'ŕ' => ('r', 2),
        'Ŗ' | 'ŗ' => ('r', 11),
        'Ř' | 'ř' => ('r', 6),
        'Ť' | 'ť' => ('t', 6),
        'Ţ' | 'ţ' => ('t', 11),
        'Ď' | 'ď' => ('d', 6),
        'Ș' | 'ș' => ('s', 11),
        'Ț' | 'ț' => ('t', 11),
        'Ĩ' | 'ĩ' => ('i', 9),
        'Ũ' | 'ũ' => ('u', 9),
        'Ŷ' | 'ŷ' => ('y', 5),
        'Ǎ' | 'ǎ' => ('a', 6),
        'Ǐ' | 'ǐ' => ('i', 6),
        'Ǒ' | 'ǒ' => ('o', 6),
        'Ǔ' | 'ǔ' => ('u', 6),
        'Ǖ' | 'ǖ' | 'Ǘ' | 'ǘ' | 'Ǚ' | 'ǚ' | 'Ǜ' | 'ǜ' => ('u', 8),
        'Ạ' | 'ạ' | 'Ả' | 'ả' | 'Ấ' | 'ấ' | 'Ầ' | 'ầ' | 'Ẩ' | 'ẩ' | 'Ẫ' | 'ẫ' | 'Ậ' | 'ậ' | 'Ắ'
        | 'ắ' | 'Ằ' | 'ằ' | 'Ẳ' | 'ẳ' | 'Ẵ' | 'ẵ' | 'Ặ' | 'ặ' => ('a', 15),
        'Ẹ' | 'ẹ' | 'Ẻ' | 'ẻ' | 'Ẽ' | 'ẽ' | 'Ế' | 'ế' | 'Ề' | 'ề' | 'Ể' | 'ể' | 'Ễ' | 'ễ' | 'Ệ'
        | 'ệ' => ('e', 15),
        'Ị' | 'ị' | 'Ỉ' | 'ỉ' => ('i', 15),
        'Ọ' | 'ọ' | 'Ỏ' | 'ỏ' | 'Ố' | 'ố' | 'Ồ' | 'ồ' | 'Ổ' | 'ổ' | 'Ỗ' | 'ỗ' | 'Ộ' | 'ộ' | 'Ớ'
        | 'ớ' | 'Ờ' | 'ờ' | 'Ở' | 'ở' | 'Ỡ' | 'ỡ' | 'Ợ' | 'ợ' => ('o', 15),
        'Ụ' | 'ụ' | 'Ủ' | 'ủ' | 'Ứ' | 'ứ' | 'Ừ' | 'ừ' | 'Ử' | 'ử' | 'Ữ' | 'ữ' | 'Ự' | 'ự' => {
            ('u', 15)
        }
        'Ỳ' | 'ỳ' | 'Ỵ' | 'ỵ' | 'Ỷ' | 'ỷ' | 'Ỹ' | 'ỹ' => ('y', 15),
        _ => (c, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::locale_compare;
    use std::cmp::Ordering;

    #[test]
    fn directory_order_matches_canonical_equivalence_vectors() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("tests/fixtures/directory-parity.json")).unwrap();
        for case in cases {
            let a = case["a"].as_str().unwrap();
            let b = case["b"].as_str().unwrap();
            let expected = case["expected"].as_i64().unwrap().cmp(&0);
            assert_eq!(locale_compare(a, b), expected, "{a:?} vs {b:?}");
        }
    }

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

    #[test]
    fn directory_order_matches_legacy_for_punctuation_and_special_letters() {
        // Expected signs come from the legacy JavaScript localeCompare.
        let cases = [
            ("2024-01", "2024_01", Ordering::Greater),
            ("-x", "_x", Ordering::Greater),
            (".a", "_a", Ordering::Greater),
            ("Øst", "Pa", Ordering::Less),
            ("Æb", "af", Ordering::Less),
            ("Straße", "Strasy", Ordering::Less),
            ("Ÿa", "yb", Ordering::Less),
            ("Þ", "z", Ordering::Greater),
            ("ıa", "ib", Ordering::Greater),
            ("á", "à", Ordering::Less),
            ("e\u{301}z", "ea", Ordering::Greater),
            ("Œuvre", "of", Ordering::Less),
            ("Ștefan", "Sz", Ordering::Less),
            ("Țara", "Tz", Ordering::Less),
            ("ạa", "ab", Ordering::Less),
            ("ắa", "ab", Ordering::Less),
            ("ĩa", "ib", Ordering::Less),
            ("ũa", "ub", Ordering::Less),
            ("ŷa", "yb", Ordering::Less),
            ("ǎa", "ab", Ordering::Less),
            ("\"a", "$a", Ordering::Less),
            ("<a", "=a", Ordering::Less),
            ("§a", "@a", Ordering::Less),
            ("ő", "ō", Ordering::Less),
            ("ŧb", "tz", Ordering::Greater),
            ("ŋa", "za", Ordering::Less),
            ("ẞa", "ssb", Ordering::Less),
        ];
        for (a, b, expected) in cases {
            assert_eq!(locale_compare(a, b), expected, "{a} vs {b}");
        }
    }
}
