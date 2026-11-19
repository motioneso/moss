//! Build the current account's offered list for each chat op.
use std::sync::Arc;
use moss_agents::{
    approvals::{FamilyFacts, Risk, Tier, ToolFacts},
    gateway::ToolDef,
};
use moss_module_host::chat_tools::ChatToolRule;
use safety_core::access::AccessContext;

pub type Source = Arc<dyn Fn() -> Result<Vec<ToolDef>, String> + Send + Sync>;

pub fn source(modules: crate::modules::Slot, access: AccessContext) -> Source {
    Arc::new(move || {
        // A debug-only real-data fixture for the live runner kill gate, never a release input.
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("MOSS_CHAT_TEST_TOOLS_FILE") {
            return serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string());
        }
        let mut tools = vec![moss_agents::builtins::current_time()];
        let application = modules.lock().map_err(|_| "Module host is busy")?
            .as_ref().map(|m| m.application.clone());
        if let Some(application) = application {
            for def in application.installer.chat_tools(&access).map_err(|_| "Cannot list chat tools")? {
                // Cards do not have a browser surface until part 3b.
                if matches!(def.rule, ChatToolRule::Card { .. }) { continue; }
                let risk = match def.risk.as_str() {
                    "read" => Risk::Read, "write" => Risk::Write,
                    _ => return Err("Unexpected chat tool risk".into()),
                };
                tools.push(ToolDef {
                    name: def.wire_name, module: Some(def.module), description: def.description,
                    input_schema: def.input_schema,
                    facts: ToolFacts {
                        risk, is_external: false, execution_auto: true, confirm_under_yolo: false,
                        family: Some(Some(FamilyFacts { default_tier: Tier::TrustedAuto,
                            allowed_tiers: vec![Tier::TrustedAuto, Tier::AlwaysConfirm], stored_tier: None })),
                    },
                });
            }
        }
        Ok(tools)
    })
}
