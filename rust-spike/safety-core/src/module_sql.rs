//! Which module SQL the installer will run.
//!
//! A module's migrations live in its own `sql/` folder and touch only the tables its manifest
//! owns. Every file is parsed as PostgreSQL, never pattern-matched, and must be one statement of
//! an allowed kind:
//!
//! - `CREATE TABLE`, `ALTER TABLE` and `CREATE [UNIQUE] INDEX` on an owned table;
//! - `UPDATE` and `DELETE` that read and write owned tables only;
//! - `COMMENT ON` an owned table or one of its columns;
//! - `DROP INDEX` of an index the module's own earlier files created.
//!
//! Foreign keys may point at owned tables or `app.users`. Expressions may call only the plain
//! functions in [`ALLOWED_FUNCTIONS`], so `set_config`, `current_setting`, `nextval` and file
//! functions are refused. Row-level security, policies and grants are written by the platform,
//! so no module statement may change them.
//!
//! The planner also refuses a `sql/` folder that is, or sits inside, the shared migrations
//! folder, a file reached through a symbolic link, and an applied file that was edited or
//! removed.

use std::collections::HashSet;
use std::fmt;
use std::ops::ControlFlow;

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlparser::ast::{
    visit_expressions, visit_relations, AlterTable, AlterTableOperation, ColumnOption,
    CommentObject, CreateIndex, CreateTable, Delete, DropBehavior, Expr, ForeignKeyConstraint,
    FromTable, Ident, ObjectName, ObjectNamePart, ObjectType, Statement, TableConstraint,
    TableFactor, Update,
};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::keywords::Keyword;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Location, Token, TokenWithSpan, Tokenizer};
use vault::{EntryKind, Root, VaultError};

/// Functions a module expression may call, with no schema or `pg_catalog`.
pub const ALLOWED_FUNCTIONS: &[&str] = &[
    "abs",
    "array_length",
    "btrim",
    "cardinality",
    "ceil",
    "char_length",
    "coalesce",
    "date_trunc",
    "floor",
    "gen_random_uuid",
    "greatest",
    "jsonb_array_length",
    "jsonb_build_array",
    "jsonb_build_object",
    "jsonb_typeof",
    "least",
    "length",
    "lower",
    "now",
    "nullif",
    "round",
    "trim",
    "upper",
];

/// The core table every module may reference by foreign key.
const SHARED_REFERENCE: (&str, &str) = ("app", "users");

/// The most tables one module may own, as in the TypeScript manifest check.
const MAX_OWNED_TABLES: usize = 32;

/// The part of a module manifest the installer needs.
#[derive(Clone, Debug)]
pub struct ModuleManifest {
    id: String,
    prefix: String,
    owned: Vec<(String, String)>,
}

impl ModuleManifest {
    /// `id` and `database.ownedTables` from `jarvis.module.json`, checked as the TypeScript
    /// validator does: `app.<id with - as _>_<name>`, lowercase, at most 32, no repeats.
    pub fn from_json(manifest: &Value) -> Result<Self, Refusal> {
        let bad = |message: String| Refusal::Manifest(message);
        let id = manifest["id"]
            .as_str()
            .ok_or_else(|| bad("the manifest has no id".into()))?;
        if !is_module_id(id) {
            return Err(bad(format!(
                "module id {id:?} is not lowercase letters, digits and -"
            )));
        }
        let prefix = format!("{}_", id.replace('-', "_"));
        let tables = match &manifest["database"]["ownedTables"] {
            Value::Null => Vec::new(),
            Value::Array(tables) => tables
                .iter()
                .map(|t| t.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| bad("ownedTables must hold table names".into()))?,
            _ => return Err(bad("ownedTables must be a list".into())),
        };
        if tables.len() > MAX_OWNED_TABLES {
            return Err(bad(format!(
                "a module may own at most {MAX_OWNED_TABLES} tables"
            )));
        }
        let mut owned = Vec::with_capacity(tables.len());
        for table in tables {
            let name = table
                .strip_prefix("app.")
                .filter(|name| is_table_name(name) && name.starts_with(&prefix))
                .ok_or_else(|| bad(format!("{table:?} is not an app table named {prefix}…")))?;
            let entry = ("app".to_owned(), name.to_owned());
            if owned.contains(&entry) {
                return Err(bad(format!("{table:?} is listed twice")));
            }
            owned.push(entry);
        }
        Ok(Self {
            id: id.to_owned(),
            prefix,
            owned,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    fn owns(&self, name: &(String, String)) -> bool {
        self.owned.contains(name)
    }
}

fn is_module_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_lowercase())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn is_table_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 63
        && chars.next().is_some_and(|ch| ch.is_ascii_lowercase())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Manifest(String),
    /// The `sql/` folder is in the wrong place.
    Location(String),
    File {
        name: String,
        reason: String,
    },
    /// An applied file was edited or removed.
    Ledger(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Manifest(reason) => write!(f, "module manifest refused: {reason}"),
            Refusal::Location(reason) => write!(f, "module SQL folder refused: {reason}"),
            Refusal::File { name, reason } => {
                write!(f, "module migration {name} refused: {reason}")
            }
            Refusal::Ledger(reason) => write!(f, "module migration history refused: {reason}"),
        }
    }
}

/// One file the ledger already records for the module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedMigration {
    pub version: String,
    pub checksum: String,
}

/// One file to run, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedMigration {
    pub version: String,
    pub name: String,
    pub checksum: String,
    pub sql: String,
}

/// Checks a module's statements in file order. It remembers the indexes earlier files made, so
/// a later `DROP INDEX` can only drop one of those.
pub struct StatementChecker<'a> {
    manifest: &'a ModuleManifest,
    created_indexes: HashSet<String>,
}

impl<'a> StatementChecker<'a> {
    pub fn new(manifest: &'a ModuleManifest) -> Self {
        Self {
            manifest,
            created_indexes: HashSet::new(),
        }
    }

    pub fn check(&mut self, sql: &str) -> Result<(), String> {
        let mut statements = Parser::parse_sql(&PostgreSqlDialect {}, &checked_text(sql)?)
            .map_err(|error| format!("not valid SQL: {error}"))?;
        if statements.len() != 1 {
            return Err(format!(
                "expected exactly one SQL statement, found {}",
                statements.len()
            ));
        }
        let statement = statements.remove(0);
        let mut created_index = None;
        // The relations every statement may read or write, after the kind-specific checks.
        let relations_scope = match &statement {
            Statement::CreateTable(create) => {
                self.check_create_table(create)?;
                statement.clone()
            }
            Statement::AlterTable(alter) => {
                self.check_alter_table(alter)?;
                statement.clone()
            }
            Statement::CreateIndex(index) => {
                created_index = self.check_create_index(index)?;
                // The index's own name is not a table; it was checked above.
                let mut unnamed = index.clone();
                unnamed.name = None;
                Statement::CreateIndex(unnamed)
            }
            Statement::Update(update) => {
                self.check_update(update)?;
                statement.clone()
            }
            Statement::Delete(delete) => {
                self.check_delete(delete)?;
                statement.clone()
            }
            Statement::Comment {
                object_type,
                object_name,
                ..
            } => {
                self.check_comment(object_type, object_name)?;
                statement.clone()
            }
            Statement::Drop {
                object_type: ObjectType::Index,
                names,
                cascade,
                ..
            } => {
                self.check_drop_index(names, *cascade)?;
                statement.clone()
            }
            _ => {
                return Err("only CREATE TABLE, CREATE INDEX, ALTER TABLE, DROP INDEX, \
                            COMMENT ON, UPDATE and DELETE are allowed"
                    .into())
            }
        };
        self.check_relations(&relations_scope)?;
        check_functions(&statement)?;
        if let Some(name) = created_index {
            self.created_indexes.insert(name);
        }
        Ok(())
    }

    fn owned_table(&self, name: &ObjectName, what: &str) -> Result<(), String> {
        let table = qualified(name).ok_or_else(|| {
            format!("{what} {name} must be written as app.<table>, schema included")
        })?;
        if self.manifest.owns(&table) {
            Ok(())
        } else {
            Err(format!("{what} {name} is not a table this module owns"))
        }
    }

    fn reference(&self, key: &ForeignKeyConstraint) -> Result<(), String> {
        let target = qualified(&key.foreign_table);
        let shared = (SHARED_REFERENCE.0.to_owned(), SHARED_REFERENCE.1.to_owned());
        match target {
            Some(table) if self.manifest.owns(&table) || table == shared => Ok(()),
            _ => Err(format!(
                "a foreign key may point only at this module's tables or app.users, not {}",
                key.foreign_table
            )),
        }
    }

    fn column_options<'o>(
        &self,
        options: impl Iterator<Item = &'o ColumnOption>,
    ) -> Result<(), String> {
        for option in options {
            if let ColumnOption::ForeignKey(key) = option {
                self.reference(key)?;
            }
        }
        Ok(())
    }

    fn table_constraint(&self, constraint: &TableConstraint) -> Result<(), String> {
        if let TableConstraint::ForeignKey(key) = constraint {
            self.reference(key)?;
        }
        Ok(())
    }

    fn check_create_table(&self, create: &CreateTable) -> Result<(), String> {
        self.owned_table(&create.name, "table")?;
        let refused = [
            (create.temporary, "TEMPORARY"),
            (create.external, "EXTERNAL"),
            (create.or_replace, "OR REPLACE"),
            (create.query.is_some(), "AS SELECT"),
            (create.like.is_some(), "LIKE"),
            (create.clone.is_some(), "CLONE"),
            (create.inherits.is_some(), "INHERITS"),
            (create.partition_of.is_some(), "PARTITION OF"),
        ];
        if let Some((_, clause)) = refused.iter().find(|(present, _)| *present) {
            return Err(format!("CREATE TABLE … {clause} is not allowed"));
        }
        for column in &create.columns {
            self.column_options(column.options.iter().map(|option| &option.option))?;
        }
        for constraint in &create.constraints {
            self.table_constraint(constraint)?;
        }
        Ok(())
    }

    fn check_alter_table(&self, alter: &AlterTable) -> Result<(), String> {
        self.owned_table(&alter.name, "table")?;
        if alter.table_type.is_some() || alter.location.is_some() || alter.on_cluster.is_some() {
            return Err("this ALTER TABLE form is not allowed".into());
        }
        for operation in &alter.operations {
            match operation {
                AlterTableOperation::AddColumn { column_def, .. } => {
                    self.column_options(column_def.options.iter().map(|option| &option.option))?
                }
                AlterTableOperation::AddConstraint { constraint, .. } => {
                    self.table_constraint(constraint)?
                }
                AlterTableOperation::DropConstraint { drop_behavior, .. }
                | AlterTableOperation::DropColumn { drop_behavior, .. } => {
                    if matches!(drop_behavior, Some(DropBehavior::Cascade)) {
                        return Err("CASCADE could drop objects outside this module".into());
                    }
                }
                AlterTableOperation::AlterColumn { .. }
                | AlterTableOperation::RenameColumn { .. }
                | AlterTableOperation::RenameConstraint { .. }
                | AlterTableOperation::ValidateConstraint { .. } => {}
                other => {
                    return Err(format!(
                        "ALTER TABLE may add, change, rename and drop columns and constraints, \
                         not {other}"
                    ))
                }
            }
        }
        Ok(())
    }

    /// Returns the index's name, if it has one.
    fn check_create_index(&self, index: &CreateIndex) -> Result<Option<String>, String> {
        self.owned_table(&index.table_name, "index table")?;
        let Some(name) = &index.name else {
            return Ok(None);
        };
        match name.0.as_slice() {
            [ObjectNamePart::Identifier(ident)] => {
                let name = normalize(ident);
                if name.starts_with(&self.manifest.prefix) {
                    Ok(Some(name))
                } else {
                    Err(format!(
                        "index {name} must be named {}…",
                        self.manifest.prefix
                    ))
                }
            }
            _ => Err(format!("index name {name} must be a plain name")),
        }
    }

    fn check_update(&self, update: &Update) -> Result<(), String> {
        if !update.table.joins.is_empty() {
            return Err("UPDATE may not join other tables to its target".into());
        }
        match &update.table.relation {
            TableFactor::Table { name, .. } => self.owned_table(name, "UPDATE target"),
            _ => Err("UPDATE must name its target table".into()),
        }
    }

    fn check_delete(&self, delete: &Delete) -> Result<(), String> {
        if !delete.tables.is_empty() {
            return Err("DELETE may name one target table".into());
        }
        let targets = match &delete.from {
            FromTable::WithFromKeyword(targets) | FromTable::WithoutKeyword(targets) => targets,
        };
        match targets.as_slice() {
            [target] if target.joins.is_empty() => match &target.relation {
                TableFactor::Table { name, .. } => self.owned_table(name, "DELETE target"),
                _ => Err("DELETE must name its target table".into()),
            },
            _ => Err("DELETE may name one target table".into()),
        }
    }

    fn check_comment(&self, object_type: &CommentObject, name: &ObjectName) -> Result<(), String> {
        match object_type {
            CommentObject::Table => self.owned_table(name, "table"),
            CommentObject::Column => {
                let parts = idents(name)
                    .filter(|parts| parts.len() == 3)
                    .ok_or_else(|| {
                        format!("column {name} must be written as app.<table>.<column>")
                    })?;
                let table = ObjectName(
                    parts[..2]
                        .iter()
                        .map(|ident| ObjectNamePart::Identifier((*ident).clone()))
                        .collect(),
                );
                self.owned_table(&table, "table")
            }
            _ => Err("COMMENT ON may name only an owned table or column".into()),
        }
    }

    fn check_drop_index(&self, names: &[ObjectName], cascade: bool) -> Result<(), String> {
        if cascade {
            return Err("CASCADE could drop objects outside this module".into());
        }
        for name in names {
            let index = match idents(name).as_deref() {
                Some([index]) => normalize(index),
                Some([schema, index]) if normalize(schema) == "app" => normalize(index),
                _ => return Err(format!("index {name} must be app.<index> or a plain name")),
            };
            if !self.created_indexes.contains(&index) {
                return Err(format!(
                    "index {index} was not created by this module's own files"
                ));
            }
        }
        Ok(())
    }

    fn check_relations(&self, statement: &Statement) -> Result<(), String> {
        let refused = visit_relations(statement, |name| match qualified(name) {
            Some(table) if self.manifest.owns(&table) => ControlFlow::Continue(()),
            _ => ControlFlow::Break(name.to_string()),
        });
        match refused {
            ControlFlow::Break(name) => Err(format!("{name} is not a table this module owns")),
            ControlFlow::Continue(()) => Ok(()),
        }
    }
}

fn check_functions(statement: &Statement) -> Result<(), String> {
    let refused = visit_expressions(statement, |expr| {
        if let Expr::Function(function) = expr {
            let allowed = match idents(&function.name).as_deref() {
                Some([name]) => ALLOWED_FUNCTIONS.contains(&normalize(name).as_str()),
                Some([schema, name]) => {
                    normalize(schema) == "pg_catalog"
                        && ALLOWED_FUNCTIONS.contains(&normalize(name).as_str())
                }
                _ => false,
            };
            if !allowed {
                return ControlFlow::Break(function.name.to_string());
            }
        }
        ControlFlow::Continue(())
    });
    match refused {
        ControlFlow::Break(name) => Err(format!("function {name} is not allowed in module SQL")),
        ControlFlow::Continue(()) => Ok(()),
    }
}

/// sqlparser does not know PostgreSQL 15's `ON DELETE SET NULL (columns)`. The list only
/// narrows which key columns are cleared, so the copy that is checked blanks it out, found by
/// token so strings and comments are never touched. The file still runs as written.
fn checked_text(sql: &str) -> Result<String, String> {
    let tokens = Tokenizer::new(&PostgreSqlDialect {}, sql)
        .tokenize_with_location()
        .map_err(|error| format!("not valid SQL: {error}"))?;
    let words: Vec<&TokenWithSpan> = tokens
        .iter()
        .filter(|token| !matches!(token.token, Token::Whitespace(_)))
        .collect();
    let keyword = |index: usize, wanted: &[Keyword]| {
        words.get(index).is_some_and(|token| {
            matches!(&token.token, Token::Word(word)
                if word.quote_style.is_none() && wanted.contains(&word.keyword))
        })
    };
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(sql.match_indices('\n').map(|(at, _)| at + 1))
        .collect();
    let mut text = sql.to_owned();
    for start in 0..words.len() {
        let set_null = keyword(start, &[Keyword::ON])
            && keyword(start + 1, &[Keyword::DELETE])
            && keyword(start + 2, &[Keyword::SET])
            && keyword(start + 3, &[Keyword::NULL, Keyword::DEFAULT])
            && matches!(
                words.get(start + 4).map(|token| &token.token),
                Some(Token::LParen)
            );
        let Some(close) = set_null
            .then(|| column_list_end(&words, start + 4))
            .flatten()
        else {
            continue;
        };
        let unreadable = || "could not read the SQL".to_owned();
        let from =
            byte_offset(sql, &line_starts, words[start + 4].span.start).ok_or_else(unreadable)?;
        let to = byte_offset(sql, &line_starts, words[close].span.end).ok_or_else(unreadable)?;
        let blank: String = sql[from..to]
            .chars()
            .map(|ch| if ch == '\n' { '\n' } else { ' ' })
            .collect();
        // Same length only if every blanked char was one byte; pad to keep offsets stable.
        let blank = format!("{blank:<width$}", width = to - from);
        text.replace_range(from..to, &blank);
    }
    Ok(text)
}

/// The index of the `)` closing `( name [, name]* )` that opens at `open`.
fn column_list_end(words: &[&TokenWithSpan], open: usize) -> Option<usize> {
    let mut index = open + 1;
    loop {
        if !matches!(words.get(index)?.token, Token::Word(_)) {
            return None;
        }
        index += 1;
        match words.get(index)?.token {
            Token::Comma => index += 1,
            Token::RParen => return Some(index),
            _ => return None,
        }
    }
}

/// A tokenizer location (1-based line and column, in characters) as a byte offset.
fn byte_offset(sql: &str, line_starts: &[usize], at: Location) -> Option<usize> {
    let line = usize::try_from(at.line).ok()?.checked_sub(1)?;
    let column = usize::try_from(at.column).ok()?.checked_sub(1)?;
    let start = *line_starts.get(line)?;
    let rest = &sql[start..];
    match rest.char_indices().nth(column) {
        Some((at, _)) => Some(start + at),
        None if rest.chars().count() == column => Some(sql.len()),
        None => None,
    }
}

/// The parts of a dotted name, if every part is a plain identifier.
fn idents(name: &ObjectName) -> Option<Vec<&Ident>> {
    name.0
        .iter()
        .map(|part| match part {
            ObjectNamePart::Identifier(ident) => Some(ident),
            _ => None,
        })
        .collect()
}

/// Postgres folds an unquoted name to lowercase and keeps a quoted one exactly.
fn normalize(ident: &Ident) -> String {
    match ident.quote_style {
        Some(_) => ident.value.clone(),
        None => ident.value.to_ascii_lowercase(),
    }
}

/// `schema.table` as Postgres resolves it. An unqualified name depends on the search path, so
/// it is never taken as owned.
fn qualified(name: &ObjectName) -> Option<(String, String)> {
    match idents(name)?.as_slice() {
        [schema, table] => Some((normalize(schema), normalize(table))),
        _ => None,
    }
}

/// The files of a module to run, in order. `module_root` is the module's folder,
/// `shared_migrations` the platform's own migrations folder, `applied` the ledger's rows for
/// this module.
pub fn plan_module_migrations(
    module_root: &Root,
    shared_migrations: &Root,
    manifest: &ModuleManifest,
    applied: &[AppliedMigration],
) -> Result<Vec<PlannedMigration>, Refusal> {
    let location = |reason: String| Refusal::Location(reason);
    let sql = match module_root.subdir("sql") {
        Ok(sql) => sql,
        Err(VaultError::NotFound(_)) => return ledger(applied, &[]).map(|()| Vec::new()),
        Err(VaultError::Escape(_)) => return Err(location("sql is a symbolic link".into())),
        Err(error) => return Err(location(error.to_string())),
    };
    if shared_migrations.contains(&sql) || sql.contains(shared_migrations) {
        return Err(location(
            "module SQL may not live in or around the shared migrations folder".into(),
        ));
    }

    let mut files = Vec::new();
    let entries = sql.list("").map_err(|error| location(error.to_string()))?;
    for entry in entries
        .into_iter()
        .filter(|entry| entry.name.ends_with(".sql"))
    {
        let refuse = |reason: &str| Refusal::File {
            name: entry.name.clone(),
            reason: reason.into(),
        };
        match entry.kind {
            EntryKind::File => {}
            EntryKind::Link => return Err(refuse("it is a symbolic link")),
            _ => return Err(refuse("it is not a plain file")),
        }
        let version = migration_version(&entry.name)
            .ok_or_else(|| refuse("the name must be <number>_<words>.sql"))?;
        let text = sql
            .read_to_string(&entry.name)
            .map_err(|error| refuse(&error.to_string()))?;
        files.push(PlannedMigration {
            version: version.to_owned(),
            checksum: sha256_hex(text.as_bytes()),
            name: entry.name,
            sql: text,
        });
    }

    let mut versions = HashSet::new();
    for file in &files {
        if !versions.insert(file.version.as_str()) {
            return Err(Refusal::File {
                name: file.name.clone(),
                reason: format!("version {} is used twice", file.version),
            });
        }
    }
    ledger(applied, &files)?;

    let mut checker = StatementChecker::new(manifest);
    for file in &files {
        checker.check(&file.sql).map_err(|reason| Refusal::File {
            name: file.name.clone(),
            reason,
        })?;
    }
    let applied: HashSet<&str> = applied.iter().map(|row| row.version.as_str()).collect();
    Ok(files
        .into_iter()
        .filter(|file| !applied.contains(file.version.as_str()))
        .collect())
}

/// Every applied file must still be there, unchanged.
fn ledger(applied: &[AppliedMigration], files: &[PlannedMigration]) -> Result<(), Refusal> {
    for row in applied {
        match files.iter().find(|file| file.version == row.version) {
            None => {
                return Err(Refusal::Ledger(format!(
                    "applied version {} is missing",
                    row.version
                )))
            }
            Some(file) if file.checksum != row.checksum => {
                return Err(Refusal::Ledger(format!(
                    "{} changed after it was applied; add a new file instead",
                    file.name
                )))
            }
            Some(_) => {}
        }
    }
    Ok(())
}

fn migration_version(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".sql")?;
    let (version, words) = stem.split_once('_')?;
    let plain = |text: &str, extra: &[char]| {
        !text.is_empty()
            && text
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || extra.contains(&ch))
    };
    (version.chars().all(|ch| ch.is_ascii_digit())
        && plain(version, &[])
        && plain(words, &['_', '-']))
    .then_some(version)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    /// The repository's external modules, read the way an install reads them.
    fn external_modules() -> Root {
        Root::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../external-modules")).unwrap()
    }

    fn manifest_of(modules: &Root, id: &str) -> ModuleManifest {
        let text = modules
            .subdir(id)
            .unwrap()
            .read_to_string("jarvis.module.json")
            .unwrap();
        ModuleManifest::from_json(&serde_json::from_str(&text).unwrap()).unwrap()
    }

    fn finance() -> ModuleManifest {
        ModuleManifest::from_json(&json!({
            "id": "finance",
            "database": {"ownedTables": ["app.finance_items", "app.finance_accounts"]}
        }))
        .unwrap()
    }

    fn check(sql: &str) -> Result<(), String> {
        StatementChecker::new(&finance()).check(sql)
    }

    #[test]
    fn accepts_every_shipped_module_migration() {
        let modules = external_modules();
        let shared = Root::open(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra/postgres/migrations"),
        )
        .unwrap();
        let mut total = 0;
        for id in ["finance", "job-search", "meals"] {
            let manifest = manifest_of(&modules, id);
            let planned =
                plan_module_migrations(&modules.subdir(id).unwrap(), &shared, &manifest, &[])
                    .unwrap_or_else(|refusal| panic!("{id}: {refusal}"));
            total += planned.len();
        }
        assert_eq!(total, 80, "every shipped module migration is planned");
    }

    #[test]
    fn accepts_the_allowed_statement_kinds() {
        let manifest = finance();
        let mut checker = StatementChecker::new(&manifest);
        for sql in [
            "CREATE TABLE app.finance_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), \
             owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE, \
             account_id uuid REFERENCES app.finance_accounts(id), \
             label text NOT NULL CHECK (char_length(label) <= 200), \
             created_at timestamptz NOT NULL DEFAULT now())",
            "ALTER TABLE app.finance_items ADD COLUMN note text, \
             ADD CONSTRAINT finance_items_note_len CHECK (length(note) < 500)",
            "CREATE UNIQUE INDEX finance_items_owner_label_idx ON app.finance_items (owner_user_id, lower(label))",
            "DROP INDEX app.finance_items_owner_label_idx",
            "UPDATE app.finance_items SET note = NULL WHERE account_id IN \
             (SELECT id FROM app.finance_accounts WHERE label = '')",
            "DELETE FROM app.finance_items WHERE note = ''",
            "COMMENT ON TABLE app.finance_items IS 'items'",
            "COMMENT ON COLUMN app.finance_items.note IS 'free text'",
            "-- a comment line\nALTER TABLE app.finance_items DROP CONSTRAINT finance_items_note_len;",
        ] {
            checker.check(sql).unwrap_or_else(|reason| panic!("{sql}: {reason}"));
        }
    }

    #[test]
    fn refuses_sql_that_reaches_past_the_module() {
        let cases = [
            ("another module's table", "ALTER TABLE app.meals_plans ADD COLUMN x int"),
            ("a core table", "UPDATE app.users SET name = 'x'"),
            ("a core read", "UPDATE app.finance_items SET note = (SELECT email FROM app.users LIMIT 1)"),
            ("a joined read", "DELETE FROM app.finance_items USING app.auth_accounts a WHERE a.id IS NULL"),
            ("an unqualified name", "CREATE TABLE finance_items (id uuid)"),
            ("a quoted schema", "CREATE TABLE \"App\".finance_items (id uuid)"),
            ("two statements", "CREATE TABLE app.finance_items (id uuid); SET ROLE postgres"),
            ("a role change", "SET ROLE postgres"),
            ("a grant", "GRANT SELECT ON app.users TO public"),
            ("a policy", "CREATE POLICY p ON app.finance_items USING (true)"),
            ("a function", "CREATE FUNCTION app.finance_f() RETURNS int AS 'select 1' LANGUAGE sql"),
            ("a setting call", "DELETE FROM app.finance_items WHERE set_config('app.actor_user_id', '', true) IS NULL"),
            ("a settings read", "UPDATE app.finance_items SET note = current_setting('app.actor_user_id')"),
            ("RLS off", "ALTER TABLE app.finance_items DISABLE ROW LEVEL SECURITY"),
            ("a rename away", "ALTER TABLE app.finance_items RENAME TO meals_plans"),
            ("a copy of users", "CREATE TABLE app.finance_items AS SELECT * FROM app.users"),
            ("a foreign key out", "ALTER TABLE app.finance_items ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES app.auth_accounts(id)"),
            ("a core index", "DROP INDEX app.users_email_key"),
            ("an index on users", "CREATE INDEX finance_users_idx ON app.users (email)"),
            ("a cascade", "ALTER TABLE app.finance_items DROP COLUMN note CASCADE"),
            ("a temporary table", "CREATE TEMPORARY TABLE app.finance_items (id uuid)"),
            ("a truncate", "TRUNCATE app.finance_items"),
            ("a comment on users", "COMMENT ON COLUMN app.users.email IS 'x'"),
        ];
        for (what, sql) in cases {
            assert!(check(sql).is_err(), "{what} was allowed: {sql}");
        }
    }

    #[test]
    fn reads_set_null_column_lists_without_touching_strings() {
        let sql = "CREATE TABLE app.finance_items (id uuid, account_id uuid,\n\
                   FOREIGN KEY (account_id) REFERENCES app.finance_accounts (id)\n\
                   ON DELETE SET NULL (account_id), note text DEFAULT 'ON DELETE SET NULL (x)')";
        let text = checked_text(sql).unwrap();
        assert_eq!(text.len(), sql.len());
        assert!(!text.contains("NULL (account_id)") && text.contains("'ON DELETE SET NULL (x)'"));
        check(sql).unwrap();
    }

    #[test]
    fn refuses_bad_manifests() {
        for manifest in [
            json!({"id": "finance", "database": {"ownedTables": ["app.meals_plans"]}}),
            json!({"id": "finance", "database": {"ownedTables": ["public.finance_x"]}}),
            json!({"id": "finance", "database": {"ownedTables": ["app.Finance_x"]}}),
            json!({"id": "finance", "database": {"ownedTables": ["app.finance_x", "app.finance_x"]}}),
            json!({"id": "Finance"}),
        ] {
            assert!(ModuleManifest::from_json(&manifest).is_err(), "{manifest}");
        }
    }

    fn module_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Root, Root) {
        let dir = tempfile::tempdir().unwrap();
        let root = Root::create(&dir.path().join("modules/finance")).unwrap();
        let sql = root.create_subdir("sql").unwrap();
        for (name, text) in files {
            sql.write(name, text.as_bytes()).unwrap();
        }
        let shared = Root::create(&dir.path().join("shared")).unwrap();
        (dir, root, shared)
    }

    const CREATE: &str = "CREATE TABLE app.finance_items (id uuid PRIMARY KEY)";

    #[test]
    fn plans_only_unapplied_files_and_refuses_edited_history() {
        let (_dir, root, shared) = module_with(&[
            ("0001_items.sql", CREATE),
            (
                "0002_note.sql",
                "ALTER TABLE app.finance_items ADD COLUMN note text",
            ),
        ]);
        let all = plan_module_migrations(&root, &shared, &finance(), &[]).unwrap();
        let first = AppliedMigration {
            version: "0001".into(),
            checksum: all[0].checksum.clone(),
        };
        let rest = plan_module_migrations(&root, &shared, &finance(), &[first]).unwrap();
        assert_eq!(
            rest.iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            ["0002_note.sql"]
        );

        let edited = AppliedMigration {
            version: "0001".into(),
            checksum: sha256_hex(b"old text"),
        };
        assert!(matches!(
            plan_module_migrations(&root, &shared, &finance(), &[edited]),
            Err(Refusal::Ledger(_))
        ));
        let missing = AppliedMigration {
            version: "0009".into(),
            checksum: String::new(),
        };
        assert!(matches!(
            plan_module_migrations(&root, &shared, &finance(), &[missing]),
            Err(Refusal::Ledger(_))
        ));
    }

    #[test]
    fn refuses_a_module_folder_in_the_shared_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let shared = Root::create(&dir.path().join("infra/postgres/migrations")).unwrap();
        let inside = Root::create(&dir.path().join("infra/postgres/migrations/finance")).unwrap();
        inside
            .create_subdir("sql")
            .unwrap()
            .write("0001_items.sql", CREATE.as_bytes())
            .unwrap();
        assert!(matches!(
            plan_module_migrations(&inside, &shared, &finance(), &[]),
            Err(Refusal::Location(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_sql_reached_through_a_link() {
        let (dir, root, shared) = module_with(&[]);
        shared.write("0001_core.sql", CREATE.as_bytes()).unwrap();
        std::os::unix::fs::symlink(
            shared.path().join("0001_core.sql"),
            root.path().join("sql/0001_core.sql"),
        )
        .unwrap();
        assert!(matches!(
            plan_module_migrations(&root, &shared, &finance(), &[]),
            Err(Refusal::File { .. })
        ));

        let linked = Root::create(&dir.path().join("modules/linked")).unwrap();
        std::os::unix::fs::symlink(shared.path(), linked.path().join("sql")).unwrap();
        assert!(matches!(
            plan_module_migrations(&linked, &shared, &finance(), &[]),
            Err(Refusal::Location(_))
        ));
    }

    #[test]
    fn refuses_bad_file_names_and_repeated_versions() {
        let (_dir, root, shared) = module_with(&[("items.sql", CREATE)]);
        assert!(matches!(
            plan_module_migrations(&root, &shared, &finance(), &[]),
            Err(Refusal::File { .. })
        ));
        let (_dir, root, shared) =
            module_with(&[("0001_items.sql", CREATE), ("0001_again.sql", CREATE)]);
        assert!(matches!(
            plan_module_migrations(&root, &shared, &finance(), &[]),
            Err(Refusal::File { .. })
        ));
    }
}
