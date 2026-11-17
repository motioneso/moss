//! Plaid calls through the host credentials broker. The package never holds the client keys or a
//! bank token. The host attaches them, and strips every secret-looking field from the reply.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

const HOST: &str = "production.plaid.com";
pub const KEYS: &str = "plaid-keys";
pub const ITEM: &str = "plaid-item";
const MAX_DETAIL: usize = 500;
const MAX_SAFE: i128 = 9_007_199_254_740_991;
const COUNTRIES: [&str; 16] = [
    "US", "GB", "ES", "NL", "FR", "IE", "CA", "DE", "IT", "PL", "DK", "NO", "SE", "EE", "LT", "LV",
];

/// What Plaid refused with. The detail is scrubbed text, safe to store.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaidError {
    pub code: String,
    pub status: u16,
    pub detail: Value,
}

/// A finished call. A refusal from Plaid is data. A host failure is the outer error.
pub type Call = std::result::Result<Value, PlaidError>;

pub struct Account {
    pub id: String,
    pub name: String,
    pub official_name: Option<String>,
    pub kind: String,
    pub subtype: Option<String>,
    pub mask: Option<String>,
    pub balance_cents: i64,
    pub currency: String,
}

/// Plaid error codes are upper snake case; anything else is not trusted as one.
fn safe_code(value: &Value, status: u16) -> String {
    match value.as_str() {
        Some(code)
            if (1..=80).contains(&code.len())
                && code.as_bytes()[0].is_ascii_uppercase()
                && code.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') =>
        {
            code.to_owned()
        }
        _ => format!("http_{status}"),
    }
}

fn boundary(text: &[u8], at: usize) -> bool {
    at == 0 || !(text[at - 1].is_ascii_alphanumeric() || text[at - 1] == b'_')
}

/// Anything that looks like a Plaid token or a long digit run (account numbers) is replaced,
/// then the text is capped with an explicit truncation marker.
pub fn scrub(value: &Value) -> Value {
    let Some(text) = value.as_str() else { return Value::Null };
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &text[i..];
        let prefix = ["access-", "public-", "link-", "processor-"].iter().find(|p| rest.starts_with(**p));
        if let (Some(p), true) = (prefix, boundary(bytes, i)) {
            let mut j = i + p.len();
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
                j += 1;
            }
            if j > i + p.len() {
                out.push_str("[redacted]");
                i = j;
                continue;
            }
        }
        let ch = rest.chars().next().expect("not at end");
        out.push(ch);
        i += ch.len_utf8();
    }
    let bytes = out.as_bytes().to_vec();
    let mut done = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b' ' || bytes[j] == b'-') {
                j += 1;
            }
            while j > i + 1 && !bytes[j - 1].is_ascii_digit() {
                j -= 1;
            }
            if j - i >= 6 {
                done.push_str("[redacted]");
                i = j;
                continue;
            }
        }
        let ch = out[i..].chars().next().expect("not at end");
        done.push(ch);
        i += ch.len_utf8();
    }
    json!(if done.chars().count() > MAX_DETAIL {
        format!("{}...[truncated]", done.chars().take(MAX_DETAIL).collect::<String>())
    } else {
        done
    })
}

/// Whole dollars and fractions become integer cents, rounding half away from zero.
pub fn cents(value: &Value) -> Option<i64> {
    let text = match value {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    if text.len() > 500 {
        return None;
    }
    let (negative, rest) = match text.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, text.as_str()),
    };
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(i) => (&rest[..i], rest[i + 1..].parse::<i32>().ok()?),
        None => (rest, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole.bytes().chain(fraction.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let digits = format!("{whole}{fraction}");
    let digits = digits.trim_start_matches('0');
    let mut n: i128 = if digits.is_empty() { 0 } else { digits.parse().ok()? };
    let shift = 2 + exponent - fraction.len() as i32;
    if shift.abs() > 400 {
        return None;
    }
    if shift >= 0 {
        for _ in 0..shift {
            n = n.checked_mul(10)?;
            if n > MAX_SAFE {
                return None;
            }
        }
    } else if -shift > 38 {
        n = 0;
    } else {
        let divisor = 10i128.checked_pow((-shift) as u32)?;
        n = (n + divisor / 2) / divisor;
    }
    if n > MAX_SAFE {
        return None;
    }
    let n = n as i64;
    Some(if negative { -n } else { n })
}

/// One Plaid call. `slot` picks which bank's token the host attaches.
pub fn call<H: Host + ?Sized>(
    host: &H,
    path: &str,
    credential: &str,
    slot: Option<&str>,
    body: Value,
) -> Result<Call> {
    let mut parameters =
        json!({"url":format!("https://{HOST}{path}"),"credential":credential,"method":"POST","body":body});
    if let Some(slot) = slot {
        parameters["slot"] = json!(slot);
    }
    let reply = host.call("credentials", "request", HOST, parameters)?;
    let status = reply["status"].as_u64().unwrap_or(0) as u16;
    let body = reply["body"].clone();
    if (200..300).contains(&status) {
        return Ok(Ok(body));
    }
    Ok(Err(PlaidError {
        code: safe_code(&body["error_code"], status),
        status,
        detail: json!({
            "type": scrub(&body["error_type"]),
            "message": scrub(&body["error_message"]),
            "requestId": scrub(&body["request_id"]),
        }),
    }))
}

/// A new link, or an update-mode link for an item that needs a new sign-in. Update mode sends no
/// products, and the host attaches that item's token from its slot.
pub fn link_token_create<H: Host + ?Sized>(host: &H, client_user: &str, update_slot: Option<&str>) -> Result<Call> {
    let mut body = json!({
        "user":{"client_user_id":client_user},"client_name":"Moss","language":"en",
        "country_codes":["US"],"transactions":{"days_requested":730},"hosted_link":{}
    });
    if update_slot.is_none() {
        body["products"] = json!(["transactions"]);
    }
    let credential = if update_slot.is_some() { ITEM } else { KEYS };
    call(host, "/link/token/create", credential, update_slot, body)
}

/// The link's state ("success", "expired" or "pending") and any public tokens it produced.
pub fn link_token_get<H: Host + ?Sized>(host: &H, link_token: &str) -> Result<std::result::Result<(String, Vec<String>), PlaidError>> {
    let reply = call(host, "/link/token/get", KEYS, None, json!({"link_token":link_token}))?;
    Ok(reply.map(|body| {
        let sessions = body["link_sessions"].as_array().cloned().unwrap_or_default();
        let tokens: Vec<String> = sessions
            .iter()
            .flat_map(|s| s["results"]["item_add_results"].as_array().cloned().unwrap_or_default())
            .filter_map(|a| a["public_token"].as_str().map(str::to_owned))
            .collect();
        let status = if !tokens.is_empty() {
            "success"
        } else if sessions.iter().any(|s| s["status"] == "EXPIRED") {
            "expired"
        } else {
            "pending"
        };
        (status.to_owned(), tokens)
    }))
}

/// Swaps a public token for a stored bank token under `slot`. The reply holds only the item id.
pub fn exchange<H: Host + ?Sized>(host: &H, slot: &str, public_token: &str) -> Result<std::result::Result<String, String>> {
    let reply = host.call(
        "credentials",
        "exchange",
        HOST,
        json!({"url":format!("https://{HOST}/item/public_token/exchange"),"credential":ITEM,"slot":slot,"input":public_token}),
    )?;
    if reply["connected"] != true {
        return Ok(Err(reply["error"].as_str().unwrap_or("none").to_owned()));
    }
    Ok(match reply["body"]["item_id"].as_str() {
        Some(id) => Ok(id.to_owned()),
        None => Err("none".into()),
    })
}

fn map_account(raw: &Value) -> Option<Account> {
    Some(Account {
        id: raw["account_id"].as_str()?.to_owned(),
        name: raw["name"].as_str()?.to_owned(),
        official_name: raw["official_name"].as_str().map(str::to_owned),
        kind: raw["type"].as_str()?.to_owned(),
        subtype: raw["subtype"].as_str().map(str::to_owned),
        mask: raw["mask"].as_str().map(str::to_owned),
        balance_cents: cents(&raw["balances"]["current"]).unwrap_or(0),
        currency: raw["balances"]["iso_currency_code"].as_str().unwrap_or("USD").to_owned(),
    })
}

pub struct Listing {
    pub item_id: Option<String>,
    pub institution: Option<String>,
    pub accounts: Vec<Account>,
}

/// `/accounts/get` or `/accounts/balance/get` for the bank held under `slot`.
pub fn accounts<H: Host + ?Sized>(host: &H, slot: &str, path: &str) -> Result<std::result::Result<Listing, PlaidError>> {
    let reply = call(host, path, ITEM, Some(slot), json!({}))?;
    Ok(reply.map(|body| Listing {
        item_id: body["item"]["item_id"].as_str().map(str::to_owned),
        institution: body["item"]["institution_id"].as_str().map(str::to_owned),
        accounts: body["accounts"].as_array().map(|a| a.iter().filter_map(map_account).collect()).unwrap_or_default(),
    }))
}

/// Whether a bank token is stored under `slot`.
pub fn configured<H: Host + ?Sized>(host: &H, slot: &str) -> Result<bool> {
    let reply = host.call("credentials", "status", HOST, json!({"credential":ITEM,"slot":slot}))?;
    Ok(reply["configured"] == true)
}

/// Drops the bank token stored under `slot`.
pub fn forget<H: Host + ?Sized>(host: &H, slot: &str) -> Result<()> {
    host.call("credentials", "forget", HOST, json!({"credential":ITEM,"slot":slot}))?;
    Ok(())
}

pub fn institution_name<H: Host + ?Sized>(host: &H, institution: &str) -> Result<std::result::Result<Option<String>, PlaidError>> {
    let reply = call(
        host,
        "/institutions/get_by_id",
        KEYS,
        None,
        json!({"institution_id":institution,"country_codes":COUNTRIES}),
    )?;
    Ok(reply.map(|body| {
        body["institution"]["name"].as_str().map(|n| n.trim().to_owned()).filter(|n| !n.is_empty())
    }))
}

pub struct Page {
    pub added: Vec<Value>,
    pub modified: Vec<Value>,
    pub removed: Vec<String>,
    pub next_cursor: String,
    pub has_more: bool,
}

pub fn transactions_sync<H: Host + ?Sized>(host: &H, slot: &str, cursor: Option<&str>) -> Result<std::result::Result<Page, PlaidError>> {
    let mut body = json!({"count":100});
    if let Some(cursor) = cursor {
        body["cursor"] = json!(cursor);
    }
    let reply = call(host, "/transactions/sync", ITEM, Some(slot), body)?;
    Ok(reply.map(|body| Page {
        added: body["added"].as_array().cloned().unwrap_or_default(),
        modified: body["modified"].as_array().cloned().unwrap_or_default(),
        removed: body["removed"]
            .as_array()
            .map(|r| r.iter().filter_map(|t| t["transaction_id"].as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        next_cursor: body["next_cursor"].as_str().unwrap_or_default().to_owned(),
        has_more: body["has_more"] == true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cents_rounds_like_the_old_code() {
        assert_eq!(cents(&json!(42.5)), Some(4250));
        assert_eq!(cents(&json!(-12.345)), Some(-1235));
        assert_eq!(cents(&json!(0.005)), Some(1));
        assert_eq!(cents(&json!("1e2")), Some(10000));
        assert_eq!(cents(&json!(1e300)), None);
        assert_eq!(cents(&json!("abc")), None);
    }

    #[test]
    fn scrub_hides_tokens_and_digit_runs() {
        let text = json!("bad access-sandbox-abc123 for acct 1234 5678 9012 and 7");
        assert_eq!(scrub(&text), json!("bad [redacted] for acct [redacted] and 7"));
        let long = scrub(&json!("x".repeat(600)));
        assert!(long.as_str().unwrap().ends_with("...[truncated]"));
        assert_eq!(scrub(&json!(5)), Value::Null);
    }

    #[test]
    fn codes_keep_only_upper_snake() {
        assert_eq!(safe_code(&json!("ITEM_LOGIN_REQUIRED"), 400), "ITEM_LOGIN_REQUIRED");
        assert_eq!(safe_code(&json!("bad code!"), 502), "http_502");
    }
}
