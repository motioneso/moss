//! Build the current account's offered list for each chat op.
use moss_agents::{
    approvals::{FamilyFacts, Risk, Tier, ToolFacts},
    gateway::ToolDef,
};
use moss_module_host::chat_tools::ChatToolRule;
use safety_core::access::AccessContext;
use std::sync::Arc;

pub trait ChatTools: Send + Sync {
    fn list(&self) -> Result<Vec<ToolDef>, String>;
    fn card(
        &self,
        _: &str,
        _: &str,
        _: &serde_json::Value,
    ) -> Result<moss_module_host::chat_tools::ApprovalCardRecord, String> {
        Err("Approval details are unavailable".into())
    }
    fn run_approved(
        &self,
        _: &str,
        _: &str,
        _: serde_json::Value,
        _: Option<&str>,
    ) -> Result<String, String> {
        Err("Approved tools are unavailable".into())
    }
    fn run(&self, module: &str, tool: &str, arguments: serde_json::Value)
    -> Result<String, String>;
}
pub type Source = Arc<dyn ChatTools>;
struct InstalledTools {
    modules: crate::modules::Slot,
    access: AccessContext,
}

pub fn source(modules: crate::modules::Slot, access: AccessContext) -> Source {
    Arc::new(InstalledTools { modules, access })
}
impl ChatTools for InstalledTools {
    fn list(&self) -> Result<Vec<ToolDef>, String> {
        // An opt-in debug fixture for the live runner kill gate, never a release input.
        #[cfg(all(debug_assertions, feature = "live-proof"))]
        if let Some(path) = std::env::var_os("MOSS_CHAT_TEST_TOOLS_FILE") {
            return serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string());
        }
        let mut tools = vec![moss_agents::builtins::current_time()];
        let application = self
            .modules
            .lock()
            .map_err(|_| "Module host is busy")?
            .as_ref()
            .map(|m| m.application.clone());
        if let Some(application) = application {
            for def in application
                .installer
                .chat_tools(&self.access)
                .map_err(|_| "Cannot list chat tools")?
            {
                let risk = match def.risk.as_str() {
                    "read" => Risk::Read,
                    "write" => Risk::Write,
                    "destructive" => Risk::Destructive,
                    "outbound" => Risk::Outbound,
                    _ => return Err("Unexpected chat tool risk".into()),
                };
                tools.push(ToolDef {
                    name: def.wire_name,
                    module: Some(def.module),
                    description: def.description,
                    input_schema: def.input_schema,
                    facts: ToolFacts {
                        risk,
                        is_external: false,
                        execution_auto: !matches!(def.rule, ChatToolRule::Card { .. }),
                        confirm_under_yolo: false,
                        family: Some(Some(FamilyFacts {
                            default_tier: Tier::TrustedAuto,
                            allowed_tiers: vec![Tier::TrustedAuto, Tier::AlwaysConfirm],
                            stored_tier: matches!(def.rule, ChatToolRule::Card { pinned: false })
                                .then_some(Tier::AlwaysConfirm),
                        })),
                    },
                });
            }
        }
        Ok(tools)
    }
    fn card(
        &self,
        module: &str,
        tool: &str,
        arguments: &serde_json::Value,
    ) -> Result<moss_module_host::chat_tools::ApprovalCardRecord, String> {
        let app = self
            .modules
            .lock()
            .map_err(|_| "Module host is busy")?
            .as_ref()
            .map(|m| m.application.clone())
            .ok_or("Module host unavailable")?;
        app.installer
            .chat_tool_card(&self.access, module, tool, arguments)
            .map_err(|_| "Approval details are unavailable")?
            .ok_or("Approval details are unavailable".into())
    }
    fn run_approved(
        &self,
        module: &str,
        tool: &str,
        arguments: serde_json::Value,
        version: Option<&str>,
    ) -> Result<String, String> {
        let app = self
            .modules
            .lock()
            .map_err(|_| "Module host is busy")?
            .as_ref()
            .map(|m| m.application.clone())
            .ok_or("Module host unavailable")?;
        app.installer
            .run_approved_chat_tool(&self.access, module, tool, arguments, version)
            .map(|v| v.to_string())
            .map_err(|_| "The approved action could not run. Ask Moss again.".into())
    }
    fn run(
        &self,
        module: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<String, String> {
        let application = self
            .modules
            .lock()
            .map_err(|_| "Module host is busy")?
            .as_ref()
            .map(|m| m.application.clone())
            .ok_or("Module host unavailable")?;
        // The host validates parameters and current module/policy state, then sanitizes the reply.
        application
            .installer
            .run_chat_tool(&self.access, module, tool, arguments)
            .map(|value| value.to_string())
            .map_err(|_| "The module tool could not run".into())
    }
}
