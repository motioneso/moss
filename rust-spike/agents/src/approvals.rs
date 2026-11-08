//! Whether a Moss tool call runs at once, asks a person, or runs under YOLO.
//!
//! Port of `resolvePolicy` (`packages/ai/src/gateway/policy.ts`) and the route choice in
//! `planCall` (`packages/ai/src/gateway/gateway.ts`). The database lookups those make (family
//! manifest, stored tier, YOLO switch, conversation taint) are passed in already resolved, so
//! this stays a pure function the parity check can drive.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Read,
    Write,
    Outbound,
    Destructive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    TrustedAuto,
    AlwaysConfirm,
}

/// A tool's action family as the module declares it, plus the person's stored choice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamilyFacts {
    pub default_tier: Tier,
    pub allowed_tiers: Vec<Tier>,
    pub stored_tier: Option<Tier>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFacts {
    pub risk: Risk,
    #[serde(default)]
    pub is_external: bool,
    /// `auto` lets a trusted family run it with no card.
    #[serde(default)]
    pub execution_auto: bool,
    #[serde(default)]
    pub confirm_under_yolo: bool,
    /// The declared family, if any; `None` inside `Some` means declared but unreadable.
    #[serde(default)]
    pub family: Option<Option<FamilyFacts>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CallFacts {
    #[serde(default)]
    pub force_confirm: bool,
    #[serde(default)]
    pub confirm_when_tainted: bool,
    #[serde(default)]
    pub per_call_resolved: bool,
    #[serde(default)]
    pub confirm_override: bool,
    #[serde(default)]
    pub sorted_safe: bool,
    #[serde(default)]
    pub yolo: bool,
    /// Outside content entered this conversation.
    #[serde(default)]
    pub tainted: bool,
    /// The person marked that outside content as trusted.
    #[serde(default)]
    pub marked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Route {
    AutoRun,
    Confirm,
    YoloRun,
    YoloConfirm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Run,
    Confirm,
}

pub fn resolve_policy(tool: &ToolFacts, call: &CallFacts, sorted_safe: bool, tainted: bool) -> Policy {
    if tainted && call.confirm_when_tainted {
        return Policy::Confirm;
    }
    match tool.risk {
        Risk::Read => return Policy::Run,
        Risk::Destructive => return Policy::Confirm,
        _ => {}
    }
    if sorted_safe && tool.is_external && !tainted {
        return if call.confirm_override { Policy::Confirm } else { Policy::Run };
    }
    if tool.risk == Risk::Outbound || call.confirm_override {
        return Policy::Confirm;
    }
    if call.per_call_resolved {
        return if tainted { Policy::Confirm } else { Policy::Run };
    }
    let Some(Some(family)) = &tool.family else {
        return Policy::Confirm;
    };
    let tier = family.stored_tier.unwrap_or(family.default_tier);
    if tier == Tier::TrustedAuto && tool.execution_auto && family.allowed_tiers.contains(&Tier::TrustedAuto) {
        Policy::Run
    } else {
        Policy::Confirm
    }
}

/// Whether YOLO may run this tool with no card. Fails closed.
pub fn family_allows_auto_run(tool: &ToolFacts, per_call_resolved: bool) -> bool {
    if tool.risk == Risk::Destructive || tool.confirm_under_yolo {
        return false;
    }
    if tool.is_external {
        return match &tool.family {
            None => true,
            Some(None) => false,
            Some(Some(f)) => f.allowed_tiers.contains(&Tier::TrustedAuto),
        };
    }
    // Outbound first: a per-call resolution never lets unattended mode send something out.
    if tool.risk == Risk::Outbound {
        return false;
    }
    if per_call_resolved {
        return true;
    }
    match &tool.family {
        Some(Some(f)) => tool.execution_auto && f.allowed_tiers.contains(&Tier::TrustedAuto),
        _ => false,
    }
}

pub fn route(tool: &ToolFacts, call: &CallFacts) -> Route {
    if call.force_confirm {
        return Route::Confirm;
    }
    if tool.risk == Risk::Read && !call.confirm_when_tainted {
        return Route::AutoRun;
    }
    let yolo = tool.risk != Risk::Read && call.yolo;
    let yolo_runs = yolo && !call.confirm_override && family_allows_auto_run(tool, call.per_call_resolved);
    let sorted_safe = if yolo { false } else { call.sorted_safe };
    let marked = call.tainted && call.marked;
    if call.tainted && !marked {
        return if yolo { Route::YoloConfirm } else { Route::Confirm };
    }
    if yolo {
        return if yolo_runs { Route::YoloRun } else { Route::YoloConfirm };
    }
    match resolve_policy(tool, call, sorted_safe, call.tainted && !call.yolo) {
        Policy::Run => Route::AutoRun,
        Policy::Confirm => Route::Confirm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(risk: Risk) -> ToolFacts {
        ToolFacts {
            risk,
            is_external: false,
            execution_auto: true,
            confirm_under_yolo: false,
            family: Some(Some(FamilyFacts {
                default_tier: Tier::TrustedAuto,
                allowed_tiers: vec![Tier::TrustedAuto, Tier::AlwaysConfirm],
                stored_tier: None,
            })),
        }
    }

    #[test]
    fn reads_run_and_destructive_always_asks() {
        let c = CallFacts::default();
        assert_eq!(route(&tool(Risk::Read), &c), Route::AutoRun);
        assert_eq!(route(&tool(Risk::Destructive), &c), Route::Confirm);
        let yolo = CallFacts { yolo: true, ..c };
        assert_eq!(route(&tool(Risk::Destructive), &yolo), Route::YoloConfirm);
    }

    #[test]
    fn trusted_family_writes_run_and_outside_content_asks() {
        assert_eq!(route(&tool(Risk::Write), &CallFacts::default()), Route::AutoRun);
        let tainted = CallFacts { tainted: true, ..Default::default() };
        assert_eq!(route(&tool(Risk::Write), &tainted), Route::Confirm);
    }

    #[test]
    fn yolo_runs_writes_even_past_a_marked_conversation() {
        let c = CallFacts { yolo: true, tainted: true, marked: true, ..Default::default() };
        assert_eq!(route(&tool(Risk::Write), &c), Route::YoloRun);
    }

    #[test]
    fn missing_family_asks() {
        let mut t = tool(Risk::Write);
        t.family = None;
        assert_eq!(route(&t, &CallFacts::default()), Route::Confirm);
    }

    #[test]
    fn outbound_never_runs_unattended_even_when_resolved_per_call() {
        let tool = ToolFacts {
            risk: Risk::Outbound,
            is_external: false,
            execution_auto: true,
            confirm_under_yolo: false,
            family: None,
        };
        assert!(!family_allows_auto_run(&tool, true));
        let call = CallFacts {
            yolo: true,
            per_call_resolved: true,
            ..Default::default()
        };
        assert_ne!(route(&tool, &call), Route::YoloRun);
    }
}
