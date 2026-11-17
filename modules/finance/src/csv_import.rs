//! Bank file import for manual accounts: read the file, map its columns, preview the result and
//! apply it as one receipt. The csv crate splits fields. Its caps and strict quote rules stay here.
use crate::input::{self, is_js_space, refuse, Refusal, MAX_SAFE};
use crate::ledger::{digest, first, log, text, values, Outcome, ACCOUNTS, TRANSACTIONS};
use crate::text::ascii_name;
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub const IMPORTS: &str = "app.finance_imports";
pub const MAX_ROWS: usize = 200;
pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_ROW_BYTES: usize = 500 * 1024;
const MAX_COLUMNS: usize = 50;

pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// The rules the csv crate leaves loose. A quote may only open a field and close it, and a blank
/// line is a record, never skipped. Returns the first problem as plain words.
fn check_strict(source: &str) -> std::result::Result<(), &'static str> {
    let (mut quoted, mut closed, mut empty_field, mut line_start) = (false, false, true, true);
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                } else {
                    quoted = false;
                    closed = true;
                }
            }
            line_start = false;
        } else if c == ',' || c == '\n' || c == '\r' {
            if (c == '\n' || c == '\r') && line_start && !closed {
                return Err("The CSV has a blank line; remove it and choose the file again.");
            }
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            closed = false;
            empty_field = true;
            line_start = c != ',';
        } else if c == '"' && empty_field && !closed {
            quoted = true;
            empty_field = false;
            line_start = false;
        } else {
            if closed || c == '"' {
                return Err("The CSV has malformed quotes.");
            }
            empty_field = false;
            line_start = false;
        }
    }
    if quoted {
        return Err("The CSV has an unclosed quoted field.");
    }
    Ok(())
}

/// Reads a file with a header row. A leading byte order mark is dropped.
pub fn parse(text: &str) -> std::result::Result<Table, String> {
    if text.len() > MAX_BYTES {
        return Err("Choose a CSV file no larger than 1 MiB.".into());
    }
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    check_strict(source).map_err(str::to_owned)?;
    let mut reader = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(source.as_bytes());
    let mut records: Vec<Vec<String>> = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|_| "The CSV could not be read.".to_owned())?;
        records.push(record.iter().map(str::to_owned).collect());
        if records.len() > MAX_ROWS + 1 {
            return Err("Import at most 200 data rows at a time.".into());
        }
    }
    if records.is_empty() {
        return Err("Include a header and at least one data row.".into());
    }
    let headers = records.remove(0);
    if headers.is_empty() || records.is_empty() {
        return Err("Include a header and at least one data row.".into());
    }
    if headers.len() > MAX_COLUMNS || records.iter().any(|r| r.len() != headers.len()) {
        return Err("Use at most 50 columns, with the same number of fields on every row.".into());
    }
    Ok(Table { headers, rows: records })
}

pub struct Mapping {
    pub date: i64,
    pub name: i64,
    pub amount: i64,
    pub inflow: i64,
    pub outflow: i64,
    pub notes: i64,
    pub currency: i64,
    pub date_format: String,
    pub amount_mode: String,
}

impl Mapping {
    pub fn read(input: &Map<String, Value>) -> std::result::Result<Mapping, Refusal> {
        let column = |key: &str| -> std::result::Result<i64, Refusal> {
            match input.get(key) {
                None | Some(Value::Null) => Ok(-1),
                Some(_) => input::int(input, key),
            }
        };
        let choice = |key: &str, allowed: &[&str]| -> std::result::Result<String, Refusal> {
            let v = input::required_string(input, key, None)?;
            if allowed.contains(&v.as_str()) { Ok(v) } else { Err(input::invalid(format!("{key} is unsupported"))) }
        };
        Ok(Mapping {
            date: column("date")?,
            name: column("name")?,
            amount: column("amount")?,
            inflow: column("inflow")?,
            outflow: column("outflow")?,
            notes: column("notes")?,
            currency: column("currency")?,
            date_format: choice("dateFormat", &["iso", "mdy", "dmy"])?,
            amount_mode: choice("amountMode", &["positive-out", "positive-in", "separate"])?,
        })
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn csv_date(value: &str, format: &str) -> std::result::Result<String, &'static str> {
    let trimmed = value.trim_matches(is_js_space);
    let date = if format == "iso" {
        trimmed.to_owned()
    } else {
        let parts: Vec<&str> = trimmed.split('/').collect();
        let ok = parts.len() == 3
            && parts[..2].iter().all(|p| digits(p) && p.len() <= 2)
            && digits(parts[2])
            && parts[2].len() == 4;
        if !ok {
            return Err("Use the selected date format on every row.");
        }
        let (month, day) = if format == "mdy" { (parts[0], parts[1]) } else { (parts[1], parts[0]) };
        format!("{}-{month:0>2}-{day:0>2}", parts[2])
    };
    if !input::is_calendar_date(&date) {
        return Err("Use a valid calendar date on every row.");
    }
    Ok(date)
}

/// Whole cents from text such as `-12.5`. Two decimal places at most, no grouping.
fn money(value: &str) -> std::result::Result<i64, &'static str> {
    let text = value.trim_matches(is_js_space);
    let (negative, body) = text.strip_prefix('-').map_or((false, text), |rest| (true, rest));
    let (whole, fraction) = body.split_once('.').unwrap_or((body, ""));
    let all_digits = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    let shape = all_digits(whole)
        && all_digits(fraction)
        && fraction.len() <= 2
        && if body.contains('.') { !whole.is_empty() || !fraction.is_empty() } else { !whole.is_empty() };
    if !shape {
        return Err("Amounts need a decimal point, no grouping or currency symbols, and at most two decimal places.");
    }
    let too_big = "An amount exceeds supported precision.";
    let whole_cents: i128 = if whole.is_empty() { 0 } else { whole.parse::<i128>().map_err(|_| too_big)? };
    let padded = format!("{fraction:0<2}");
    let cents = whole_cents.checked_mul(100).ok_or(too_big)? + padded.parse::<i128>().unwrap_or(0);
    let cents = if negative { -cents } else { cents };
    if cents.abs() > i128::from(MAX_SAFE) {
        return Err(too_big);
    }
    Ok(cents as i64)
}

pub struct Mapped {
    pub rows: Vec<Value>,
}

fn byte_len(value: &Value) -> usize {
    serde_json::to_string(value).map(|s| s.len()).unwrap_or(usize::MAX)
}

/// Maps file columns to import rows. A failure names the data row and never quotes its content.
pub fn map(table: &Table, m: &Mapping, currency: &str) -> std::result::Result<Mapped, String> {
    let required: Vec<i64> = if m.amount_mode == "separate" { vec![m.date, m.name, m.inflow, m.outflow] } else { vec![m.date, m.name, m.amount] };
    let selected: Vec<i64> = required.iter().copied().chain([m.notes, m.currency]).filter(|v| *v != -1).collect();
    let distinct: BTreeSet<i64> = selected.iter().copied().collect();
    if required.iter().any(|v| *v < 0) || selected.iter().any(|v| *v >= table.headers.len() as i64) || distinct.len() != selected.len() {
        return Err("Choose a different column for each mapped field.".into());
    }
    let mut rows = Vec::with_capacity(table.rows.len());
    for (index, fields) in table.rows.iter().enumerate() {
        let cell = |i: i64| fields[i as usize].as_str();
        let fail = |message: &str| format!("Data row {}: {message}", index + 1);
        let name = cell(m.name).trim_matches(is_js_space);
        let notes = if m.notes < 0 { "" } else { cell(m.notes) };
        if name.is_empty() || name.len() > 640 || notes.len() > 4000 {
            return Err(fail("Payee is required (up to 640 bytes); notes allow up to 4000 bytes."));
        }
        if m.currency >= 0 && cell(m.currency).trim_matches(is_js_space) != currency {
            return Err(fail("Every row must use this account's currency."));
        }
        let amount = if m.amount_mode == "separate" {
            let side = |i: i64| money(if cell(i).trim_matches(is_js_space).is_empty() { "0" } else { cell(i) });
            let (inflow, outflow) = (side(m.inflow).map_err(|e| fail(e))?, side(m.outflow).map_err(|e| fail(e))?);
            if inflow < 0 || outflow < 0 || (inflow != 0 && outflow != 0) {
                return Err(fail("Use one nonnegative inflow or outflow per row."));
            }
            outflow - inflow
        } else {
            let cents = money(cell(m.amount)).map_err(|e| fail(e))?;
            if m.amount_mode == "positive-out" { cents } else { -cents }
        };
        if amount == 0 {
            return Err(fail("Zero-value rows cannot be imported."));
        }
        let date = csv_date(cell(m.date), &m.date_format).map_err(|e| fail(e))?;
        rows.push(json!({"sourceRow":index + 1,"date":date,"name":name,"amountCents":amount,"notes":notes,"allowDuplicate":false}));
    }
    if byte_len(&Value::Array(rows.clone())) > MAX_ROW_BYTES {
        return Err("This batch has too much text. Choose fewer rows or shorter notes.".into());
    }
    Ok(Mapped { rows })
}

/// `finance.import.parse`: a file and a column choice in, import rows out. Nothing is stored.
pub fn parse_file(body: &Value) -> Outcome {
    let Some(input) = body.as_object() else { return Err(input::invalid("Input must be an object")) };
    let file = input::required_string(input, "csv", None)?;
    let currency = input::currency(input)?;
    let mapping = Mapping::read(input)?;
    let bad = |message: String| refuse("invalid_csv", message);
    let table = parse(&file).map_err(bad)?;
    let mapped = map(&table, &mapping, &currency).map_err(bad)?;
    Ok(json!({"status":"ok","headers":table.headers,"rows":mapped.rows}))
}

#[derive(Clone)]
pub struct Row {
    pub source_row: i64,
    pub date: String,
    pub name: String,
    pub amount: i64,
    pub notes: String,
    pub allow_duplicate: bool,
}
impl Row {
    fn json(&self) -> Value {
        json!({"sourceRow":self.source_row,"date":self.date,"name":self.name,"amountCents":self.amount,"notes":self.notes,"allowDuplicate":self.allow_duplicate})
    }
}

fn rows(input: &Map<String, Value>, today: &str) -> std::result::Result<Vec<Row>, Refusal> {
    let list = match input.get("rows") {
        Some(Value::Array(list)) if !list.is_empty() && list.len() <= MAX_ROWS => list,
        _ => return Err(input::invalid("Import between 1 and 200 rows")),
    };
    let mut parsed = Vec::with_capacity(list.len());
    for raw in list {
        let Some(value) = raw.as_object() else { return Err(input::invalid("rows must contain entries")) };
        let name = input::required_string(value, "name", Some(640))?.trim_matches(is_js_space).to_owned();
        let amount = input::int(value, "amountCents")?;
        if name.is_empty() || amount == 0 {
            return Err(input::invalid("rows need a payee and nonzero amount"));
        }
        let source_row = input::int(value, "sourceRow")?;
        if !(1..=MAX_ROWS as i64).contains(&source_row) {
            return Err(input::invalid("sourceRow must be between 1 and 200"));
        }
        parsed.push(Row {
            source_row,
            date: input::date(value, "date", today)?,
            name,
            amount,
            notes: input::string(value, "notes", false, Some(4000))?.unwrap_or_default(),
            allow_duplicate: input::bool_(value, "allowDuplicate")?,
        });
    }
    let distinct: BTreeSet<i64> = parsed.iter().map(|r| r.source_row).collect();
    if distinct.len() != parsed.len() {
        return Err(input::invalid("sourceRow must be distinct"));
    }
    let size = byte_len(&Value::Array(parsed.iter().map(Row::json).collect()));
    if size > MAX_ROW_BYTES {
        return Err(refuse("import_too_large", "Import text exceeds supported batch size"));
    }
    parsed.sort_by_key(|r| r.source_row);
    Ok(parsed)
}

/// Source rows that repeat a stored entry of the account, or another row of this file.
fn duplicates<H: Host + ?Sized>(host: &H, account: &Value, entries: &[Row]) -> Result<Vec<i64>> {
    let dates: Vec<Value> = entries.iter().map(|r| r.date.clone()).collect::<BTreeSet<String>>().into_iter().map(|d| json!(d)).collect();
    let stored = Client(host).query(
        TRANSACTIONS,
        &Query::select(Filter::And {
            filters: vec![Filter::eq("account_id", account["account_id"].clone()), Filter::In { column: "date".into(), values: dates }],
        }),
    )?;
    let currency = &account["iso_currency"];
    let found = entries.iter().filter(|r| {
        let name = ascii_name(&r.name);
        stored.iter().any(|t| {
            t["date"] == json!(r.date) && t["amount_cents"] == json!(r.amount) && &t["iso_currency"] == currency
                && ascii_name(t["name"].as_str().unwrap_or("")) == name
        }) || entries.iter().any(|o| o.source_row != r.source_row && o.date == r.date && o.amount == r.amount && ascii_name(&o.name) == name)
    });
    Ok(found.map(|r| r.source_row).collect())
}

fn balance_after(balance: i64, debt: bool, entries: &[Row]) -> Option<i64> {
    let total: i128 = entries.iter().map(|r| i128::from(r.amount)).sum();
    let moved = i128::from(balance) + if debt { total } else { -total };
    (moved.abs() <= i128::from(MAX_SAFE)).then_some(moved as i64)
}

fn manual_account<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    first(host, ACCOUNTS, Filter::And { filters: vec![Filter::eq("account_id", id), Filter::eq("source", "manual")] })
}

/// `finance.import.preview`. Reads only. Shows what the apply would do.
pub fn preview<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let today = crate::ledger::today(host)?;
    let entries = ask!(rows(input, &today));
    let currency = ask!(input::currency(input));
    let account_id = ask!(input::required_string(input, "accountId", Some(128)));
    let unavailable = || Err(refuse("manual_unavailable", "Manual account is unavailable or currency differs"));
    let account = match manual_account(host, &account_id)? {
        Some(a) if a["archived_at"].is_null() => a,
        _ => return Ok(unavailable()),
    };
    if account["iso_currency"] != json!(currency) {
        return Ok(unavailable());
    }
    let opening = account["opening_date"].as_str().unwrap_or("");
    if entries.iter().any(|r| r.date.as_str() < opening) {
        return Ok(Err(refuse("manual_invalid_date", "An entry precedes the opening balance")));
    }
    let last = account["last_reconciled_date"].as_str();
    if last.is_some_and(|l| entries.iter().any(|r| r.date.as_str() <= l)) {
        return Ok(Err(refuse("manual_reconciled_period", "An entry is in a reconciled period")));
    }
    let balance = account["balance_cents"].as_i64().ok_or_else(|| Error::new("Invalid balance"))?;
    let debt = matches!(account["type"].as_str(), Some("credit" | "loan"));
    Ok(Ok(json!({
        "status":"ok","today":today,
        "view":{"accountId":account["account_id"],"isoCurrency":account["iso_currency"],"openingDate":account["opening_date"],
            "lastReconciledDate":account["last_reconciled_date"],"revision":account["ledger_revision"],"balanceCents":balance,
            "debt":debt,"duplicateRows":duplicates(host, &account, &entries)?},
        "resultingBalanceCents":balance_after(balance, debt, &entries),
    })))
}

fn stale() -> Outcome {
    Err(refuse("stale_import", "The import no longer matches the ledger or needs duplicate decisions; refresh the preview before applying"))
}

/// `finance.import.apply`. One receipt, every row, the new balance and one activity row, or nothing.
pub fn apply<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    apply_attempt(host, body, true)
}

fn apply_attempt<H: Host + ?Sized>(host: &H, body: &Value, retry: bool) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let today = crate::ledger::today(host)?;
    let id = ask!(input::operation_id(input, "operationId"));
    let account_id = ask!(input::required_string(input, "accountId", Some(128)));
    let currency = ask!(input::currency(input));
    let revision = ask!(input::int(input, "expectedRevision"));
    if revision < 0 {
        return Ok(Err(input::invalid("expectedRevision must be at least 0")));
    }
    let entries = ask!(rows(input, &today));
    let cleared = ask!(input::bool_(input, "cleared"));

    let mut ordered = Map::new();
    ordered.insert("id".into(), json!(id));
    ordered.insert("accountId".into(), json!(account_id));
    ordered.insert("isoCurrency".into(), json!(currency));
    ordered.insert("expectedRevision".into(), json!(revision));
    ordered.insert("rows".into(), Value::Array(entries.iter().map(Row::json).collect()));
    ordered.insert("cleared".into(), json!(cleared));
    let digest = digest(&ordered)?;
    let done = |unchanged: bool| Ok(Ok(json!({"status":"ok","id":id,"entryCount":entries.len(),"unchanged":unchanged})));

    // A replay stays valid after later postings change the revision.
    if let Some(prior) = first(host, IMPORTS, Filter::eq("id", id.clone()))? {
        return if prior["operation_digest"] == json!(digest) { done(true) } else { Ok(stale()) };
    }
    let Some(account) = manual_account(host, &account_id)? else { return Ok(stale()) };
    let opening = account["opening_date"].as_str().unwrap_or("");
    let last = account["last_reconciled_date"].as_str();
    let balance = account["balance_cents"].as_i64().ok_or_else(|| Error::new("Invalid balance"))?;
    let debt = matches!(account["type"].as_str(), Some("credit" | "loan"));
    let account_ok = account["archived_at"].is_null()
        && account["iso_currency"] == json!(currency)
        && account["ledger_revision"].as_i64() == Some(revision)
        && entries.iter().all(|r| r.date.as_str() >= opening && !last.is_some_and(|l| r.date.as_str() <= l));
    let moved = balance_after(balance, debt, &entries);
    let skipped: BTreeSet<i64> = duplicates(host, &account, &entries)?.into_iter().collect();
    let unwanted = entries.iter().any(|r| !r.allow_duplicate && skipped.contains(&r.source_row));
    let Some(moved) = moved.filter(|_| account_ok && !unwanted) else { return Ok(stale()) };

    let at = text(host, "call", "read", "now")?;
    let changed = Client(host).query(
        ACCOUNTS,
        &Query::update(
            Filter::And {
                filters: vec![Filter::eq("account_id", account_id.clone()), Filter::eq("source", "manual"), Filter::eq("ledger_revision", revision)],
            },
            values(vec![("balance_cents", json!(moved)), ("ledger_revision", json!(revision + 1)), ("updated_at", json!(at))]),
        ),
    )?;
    if changed.is_empty() {
        if retry {
            return apply_attempt(host, body, false);
        }
        return Err(Error::new("The account changed during the save"));
    }
    let mut receipt = Query::insert(values(vec![
        ("id", json!(id)),
        ("account_id", json!(account_id)),
        ("entry_count", json!(entries.len())),
        ("operation_digest", json!(digest)),
        ("created_at", json!(at)),
    ]));
    receipt.conflict = Conflict::Ignore;
    if Client(host).query(IMPORTS, &receipt)?.is_empty() {
        return Err(Error::new("The import receipt already exists"));
    }
    for r in &entries {
        let row = values(vec![
            ("id", json!(format!("{id}:{}", r.source_row))),
            ("account_id", json!(account_id)),
            ("date", json!(r.date)),
            ("name", json!(r.name)),
            ("amount_cents", json!(r.amount)),
            ("iso_currency", json!(currency)),
            ("notes", if r.notes.is_empty() { Value::Null } else { json!(r.notes) }),
            ("pending", json!(false)),
            ("categorized_by", json!("user")),
            ("review_state", json!("needs_look")),
            ("source", json!("manual")),
            ("entry_digest", json!(digest)),
            ("cleared", json!(cleared)),
        ]);
        Client(host).query(TRANSACTIONS, &Query::insert(row))?;
    }
    log(host, "transaction.import", json!({"accountId":account_id,"importId":id,"entryCount":entries.len()}))?;
    done(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(mode: &str) -> Mapping {
        Mapping { date: 0, name: 1, amount: 2, inflow: 3, outflow: 4, notes: -1, currency: -1, date_format: "iso".into(), amount_mode: mode.into() }
    }
    fn table(text: &str) -> Table {
        parse(text).unwrap()
    }

    #[test]
    fn a_plain_file_reads_with_quotes_commas_and_all_line_endings() {
        let t = table("\u{feff}date,name,amount\r\n2026-11-01,\"Shop, \"\"Big\"\"\",5.00\n2026-11-02,Cafe,1\r2026-11-03,\"two\nlines\",2\n");
        assert_eq!(t.headers, vec!["date", "name", "amount"]);
        assert_eq!(t.rows.len(), 3);
        assert_eq!(t.rows[0][1], "Shop, \"Big\"");
        assert_eq!(t.rows[2][1], "two\nlines");
    }

    #[test]
    fn bad_files_are_refused_in_plain_words() {
        let cases = [
            ("a,b\n1,\"x\"y\n", "The CSV has malformed quotes."),
            ("a,b\n1,x\"y\n", "The CSV has malformed quotes."),
            ("a,b\n1,\"open\n", "The CSV has an unclosed quoted field."),
            ("a,b\n", "Include a header and at least one data row."),
            ("", "Include a header and at least one data row."),
            ("a,b\n1,2\n\n3,4\n", "The CSV has a blank line; remove it and choose the file again."),
            ("a,b\n1\n", "Use at most 50 columns, with the same number of fields on every row."),
            ("a,b\n1,2,3\n", "Use at most 50 columns, with the same number of fields on every row."),
        ];
        for (text, message) in cases {
            assert_eq!(parse(text).err().as_deref(), Some(message), "{text:?}");
        }
        let wide = format!("{}\n{}\n", vec!["h"; 51].join(","), vec!["v"; 51].join(","));
        assert!(parse(&wide).is_err());
        assert!(parse(&format!("{}\n{}\n", vec!["h"; 50].join(","), vec!["v"; 50].join(","))).is_ok());
    }

    #[test]
    fn the_size_and_row_caps_sit_exactly_at_the_old_limits() {
        let rows = |n: usize| format!("a,b\n{}", "1,2\n".repeat(n));
        assert_eq!(parse(&rows(200)).unwrap().rows.len(), 200);
        assert_eq!(parse(&rows(201)).err().as_deref(), Some("Import at most 200 data rows at a time."));
        let pad = |n: usize| format!("a\n{}\n", "x".repeat(n - 3));
        assert!(parse(&pad(MAX_BYTES)).is_ok());
        assert_eq!(parse(&pad(MAX_BYTES + 1)).err().as_deref(), Some("Choose a CSV file no larger than 1 MiB."));
    }

    #[test]
    fn amounts_follow_the_old_pattern() {
        for (text, cents) in [("5", 500), ("5.", 500), ("5.1", 510), ("5.12", 512), ("-5.12", -512), (".5", 50), ("-.05", -5), ("0", 0), (" 7.00 ", 700)] {
            assert_eq!(money(text), Ok(cents), "{text}");
        }
        for text in ["", "-", ".", "5.123", "1,000.00", "$5", "5e3", "+5", "--5", "5 5", "-.", "9007199254740992", "90071992547409.92"] {
            assert!(money(text).is_err(), "{text}");
        }
        assert_eq!(money("90071992547409.91"), Ok(9_007_199_254_740_991));
    }

    #[test]
    fn dates_follow_the_chosen_format() {
        assert_eq!(csv_date("2026-02-28", "iso"), Ok("2026-02-28".into()));
        assert_eq!(csv_date("3/4/2026", "mdy"), Ok("2026-03-04".into()));
        assert_eq!(csv_date("3/4/2026", "dmy"), Ok("2026-04-03".into()));
        assert!(csv_date("2026-02-30", "iso").is_err() && csv_date("13/1/2026", "mdy").is_err() && csv_date("1/1/26", "mdy").is_err());
        assert!(csv_date("2026-03-04", "mdy").is_err());
    }

    #[test]
    fn modes_set_the_sign() {
        let one = table("d,n,a\n2026-11-01,Shop,5.00\n");
        assert_eq!(map(&one, &mapping("positive-out"), "USD").unwrap().rows[0]["amountCents"], 500);
        assert_eq!(map(&one, &mapping("positive-in"), "USD").unwrap().rows[0]["amountCents"], -500);
        let t = table("d,n,i,o\n2026-11-02,Pay,10.00,\n2026-11-03,Out,,2.50\n");
        let m = Mapping { date: 0, name: 1, amount: -1, inflow: 2, outflow: 3, notes: -1, currency: -1, date_format: "iso".into(), amount_mode: "separate".into() };
        let rows = map(&t, &m, "USD").unwrap().rows;
        assert_eq!(rows[0]["amountCents"], -1000);
        assert_eq!(rows[1]["amountCents"], 250);
    }

    #[test]
    fn row_failures_name_the_row_and_never_the_content() {
        let t = table("d,n,a\n2026-11-01,Shop,5.00\n2026-11-02,SECRET-PAYEE,0.00\n");
        let error = map(&t, &mapping("positive-out"), "USD").err().unwrap();
        assert_eq!(error, "Data row 2: Zero-value rows cannot be imported.");
        assert!(!error.contains("SECRET"));
        let t = table("d,n,a\n2026-11-01,Shop,abc\n");
        assert_eq!(map(&t, &mapping("positive-out"), "USD").err().unwrap(), "Data row 1: Amounts need a decimal point, no grouping or currency symbols, and at most two decimal places.");
        let mut both = mapping("separate");
        both.inflow = 2;
        both.outflow = 3;
        let t = table("d,n,i,o\n2026-11-01,Shop,1.00,2.00\n");
        assert_eq!(map(&t, &both, "USD").err().unwrap(), "Data row 1: Use one nonnegative inflow or outflow per row.");
    }

    #[test]
    fn mapped_columns_must_be_distinct_and_in_range() {
        let t = table("d,n,a\n2026-11-01,Shop,5\n");
        let mut m = mapping("positive-out");
        m.notes = 1;
        assert!(map(&t, &m, "USD").is_err());
        let mut m = mapping("positive-out");
        m.amount = 9;
        assert!(map(&t, &m, "USD").is_err());
        let mut m = mapping("positive-out");
        m.date = -1;
        assert!(map(&t, &m, "USD").is_err());
    }

    #[test]
    fn a_currency_column_must_match_the_account() {
        let t = table("d,n,a,c\n2026-11-01,Shop,5,USD\n2026-11-02,Shop,5,EUR\n");
        let mut m = mapping("positive-out");
        m.currency = 3;
        assert_eq!(map(&t, &m, "USD").err().unwrap(), "Data row 2: Every row must use this account's currency.");
    }

    #[test]
    fn payee_and_note_limits_are_in_bytes() {
        let big = |n: usize| format!("d,n,a,x\n2026-11-01,{},5,{}\n", "p".repeat(n.min(640)), "n".repeat(if n > 640 { n } else { 0 }));
        let mut m = mapping("positive-out");
        m.notes = 3;
        assert!(map(&table(&big(640)), &m, "USD").is_ok());
        let long_payee = format!("d,n,a\n2026-11-01,{},5\n", "\u{e9}".repeat(321));
        assert!(map(&table(&long_payee), &mapping("positive-out"), "USD").is_err());
        let note_ok = format!("d,n,a,x\n2026-11-01,P,5,{}\n", "n".repeat(4000));
        assert!(map(&table(&note_ok), &m, "USD").is_ok());
        let note_long = format!("d,n,a,x\n2026-11-01,P,5,{}\n", "n".repeat(4001));
        assert!(map(&table(&note_long), &m, "USD").is_err());
    }

    #[test]
    fn the_balance_moves_by_sign_and_overflow_is_refused() {
        let r = |amount| Row { source_row: 1, date: "2026-11-01".into(), name: "x".into(), amount, notes: String::new(), allow_duplicate: false };
        assert_eq!(balance_after(1000, false, &[r(300)]), Some(700));
        assert_eq!(balance_after(1000, true, &[r(300)]), Some(1300));
        assert_eq!(balance_after(MAX_SAFE, true, &[r(1)]), None);
    }
}
