//! Exact managed-source export projection. Ordinary table RLS supplies the actor boundary.
use moss_module_sdk::{query::Order, query::Query, Client, Error, Host, Result};
use serde_json::{Map, Value};

const PAGE: u32 = 100;

struct Section {
    name: &'static str,
    table: &'static str,
    order: &'static [&'static str],
    fields: &'static [(&'static str, &'static str)],
}
const SECTIONS: &[Section] = &[
    Section {
        name: "actors",
        table: "app.notes_managed_actors",
        order: &["owner_user_id"],
        fields: &[
            ("owner_user_id", "ownerUserId"),
            ("generation", "generation"),
            ("state", "state"),
            ("operation_id", "operationId"),
        ],
    },
    Section {
        name: "sources",
        table: "app.notes_managed_sources",
        order: &["source_module_id", "source_id"],
        fields: &[
            ("owner_user_id", "ownerUserId"),
            ("source_module_id", "sourceModuleId"),
            ("source_id", "sourceId"),
            ("generation", "generation"),
            ("state", "state"),
            ("operation_id", "operationId"),
        ],
    },
    Section {
        name: "bindings",
        table: "app.notes_destination_bindings",
        order: &["destination_id"],
        fields: &[
            ("destination_id", "destinationId"),
            ("side", "side"),
            ("revision", "revision"),
        ],
    },
    Section {
        name: "contributions",
        table: "app.notes_recording_contributions",
        order: &["receipt_id"],
        fields: &[
            ("receipt_id", "receiptId"),
            ("source_module_id", "sourceModuleId"),
            ("source_id", "sourceId"),
            ("source_version", "sourceVersion"),
            ("source_generation", "sourceGeneration"),
            ("item_key", "itemKey"),
            ("revision", "revision"),
            ("side", "side"),
            ("state", "state"),
            ("destination", "destination"),
            ("prose", "text"),
            ("block_bytes", "blockBytes"),
            ("operation_id", "operationId"),
            ("cleanup_operation_id", "cleanupOperationId"),
        ],
    },
    Section {
        name: "proposals",
        table: "app.notes_contribution_proposals",
        order: &["proposal_id"],
        fields: &[
            ("proposal_id", "proposalId"),
            ("source_module_id", "sourceModuleId"),
            ("source_id", "sourceId"),
            ("payload", "payload"),
        ],
    },
    Section {
        name: "operations",
        table: "app.notes_contribution_operations",
        order: &["operation_id"],
        fields: &[
            ("operation_id", "operationId"),
            ("receipt_id", "receiptId"),
            ("source_module_id", "sourceModuleId"),
            ("source_id", "sourceId"),
            ("state", "state"),
            ("destination_ids", "destinationIds"),
            ("payload", "payload"),
        ],
    },
];

pub fn collect(host: &impl Host) -> Result<Value> {
    let mut result = Map::new();
    for section in SECTIONS {
        let mut query = Query {
            order: section
                .order
                .iter()
                .map(|column| Order {
                    column: (*column).into(),
                    descending: false,
                })
                .collect(),
            limit: Some(PAGE),
            ..Query::default()
        };
        let mut exported = Vec::new();
        loop {
            let rows = Client(host).query(section.table, &query)?;
            let count = rows.len();
            for row in rows {
                let mut projected = Map::new();
                for (column, field) in section.fields {
                    let value = row
                        .get(column)
                        .ok_or_else(|| Error::new("Notes export row is incomplete"))?;
                    projected.insert((*field).into(), value.clone());
                }
                exported.push(Value::Object(projected));
            }
            if count < PAGE as usize {
                break;
            }
            // The host enforces this ceiling too. Never return a silently partial export.
            query.offset = query
                .offset
                .checked_add(PAGE)
                .filter(|offset| *offset <= 1_000_000)
                .ok_or_else(|| Error::new("Notes export exceeds the host paging limit"))?;
        }
        result.insert(section.name.into(), Value::Array(exported));
    }
    Ok(Value::Object(result))
}
