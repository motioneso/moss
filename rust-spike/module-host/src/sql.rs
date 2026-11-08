//! New package SQL uses the existing parsed checker plus the stricter package-format subset.
use crate::{archive::Package, manifest::Ledger};
use anyhow::{ensure, Result};
use safety_core::module_sql::{ModuleManifest, StatementChecker};
use sqlparser::{
    ast::{AlterTableOperation, Statement},
    dialect::PostgreSqlDialect,
    parser::Parser,
};
use std::collections::BTreeMap;

/// The inventory is compiled into a host release. Publisher signatures cannot add exceptions.
pub struct LegacyInventory(pub BTreeMap<(String, String), String>);
impl Default for LegacyInventory {
    fn default() -> Self {
        Self(crate::legacy::hashes())
    }
}
pub fn check(package: &Package, inventory: &LegacyInventory) -> Result<()> {
    for path in &package.manifest.database.migrations {
        let bytes = &package.files[path];
        if inventory
            .0
            .get(&(package.manifest.id.clone(), path.clone()))
            .is_some_and(|hash| hash == &crate::trust::digest(bytes))
        {
            ensure!(
                package.manifest.database.ledger != Ledger::Module,
                "Legacy SQL must keep its original ledger"
            );
            continue;
        }
        let sql = std::str::from_utf8(bytes)?;
        let statements = Parser::parse_sql(&PostgreSqlDialect {}, sql)?;
        ensure!(
            statements.len() == 1,
            "Each migration must contain one parsed SQL statement"
        );
        let allowed = match &statements[0] {
            Statement::CreateTable(_)
            | Statement::CreateIndex(_)
            | Statement::Update(_)
            | Statement::Delete(_) => true,
            Statement::AlterTable(alter) => alter.operations.iter().all(|op| {
                matches!(
                    op,
                    AlterTableOperation::AddColumn { .. }
                        | AlterTableOperation::AddConstraint { .. }
                )
            }),
            _ => false,
        };
        ensure!(
            allowed,
            "This SQL statement is not part of the module package subset"
        );
        // Existing first-party names predate the package namespace rule. Rename only SQL
        // identifier tokens for the checker, never strings or the executed migration bytes.
        let id = package.manifest.id.replace('-', "--").replace('.', "-");
        let prefix = crate::manifest::table_prefix(&package.manifest.id);
        let aliases: BTreeMap<String, String> = package
            .manifest
            .database
            .owned_tables
            .iter()
            .filter(|t| !t.starts_with(&format!("app.{prefix}")))
            .map(|t| {
                (
                    t[4..].to_string(),
                    format!(
                        "{prefix}legacy_{}",
                        &crate::trust::digest(t.as_bytes())[..12]
                    ),
                )
            })
            .collect();
        let owned: Vec<String> = package
            .manifest
            .database
            .owned_tables
            .iter()
            .map(|t| {
                aliases
                    .get(&t[4..])
                    .map(|a| format!("app.{a}"))
                    .unwrap_or_else(|| t.clone())
            })
            .collect();
        let manifest = ModuleManifest::from_json(
            &serde_json::json!({"id":id,"database":{"ownedTables":owned}}),
        )
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let mut tokens =
            sqlparser::tokenizer::Tokenizer::new(&PostgreSqlDialect {}, sql).tokenize()?;
        for token in &mut tokens {
            if let sqlparser::tokenizer::Token::Word(word) = token {
                if let Some(alias) = aliases.get(&word.value) {
                    word.value = alias.clone();
                }
            }
        }
        let checked = tokens.iter().map(ToString::to_string).collect::<String>();
        StatementChecker::new(&manifest)
            .check(&checked)
            .map_err(anyhow::Error::msg)?;
    }
    Ok(())
}
