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
#[derive(Default)]
pub struct LegacyInventory(pub BTreeMap<(String, String), String>);
pub fn check(package: &Package, inventory: &LegacyInventory) -> Result<()> {
    let manifest = ModuleManifest::from_json(&serde_json::json!({
        "id":package.manifest.id.replace('.',"-"),
        "database":{"ownedTables":package.manifest.database.owned_tables}
    }))
    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let mut checker = StatementChecker::new(&manifest);
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
        checker.check(sql).map_err(anyhow::Error::msg)?;
    }
    Ok(())
}
