//! One account's offered tools, replaced only while holding its turn lock.

use std::sync::{Arc, Mutex};

use crate::gateway::{ToolDef, ToolFuture, ToolHost};

pub(crate) struct TurnTools {
    account: String,
    definitions: Mutex<Vec<ToolDef>>,
    executor: Arc<dyn ToolHost>,
}

impl TurnTools {
    pub fn new(account: &str, definitions: Vec<ToolDef>, executor: Arc<dyn ToolHost>) -> Self {
        Self {
            account: account.into(),
            definitions: Mutex::new(definitions),
            executor,
        }
    }

    /// Compare canonical JSON, including schemas and routing facts, independent of list order.
    pub fn replace(&self, mut definitions: Vec<ToolDef>) -> bool {
        definitions.sort_by(|a, b| a.name.cmp(&b.name));
        let mut current = self.definitions.lock().unwrap();
        current.sort_by(|a, b| a.name.cmp(&b.name));
        if serde_json::to_value(&*current).expect("tools")
            == serde_json::to_value(&definitions).expect("tools")
        {
            return false;
        }
        *current = definitions;
        true
    }
}

impl ToolHost for TurnTools {
    fn tools(&self, account: &str) -> Vec<ToolDef> {
        if account != self.account {
            return vec![];
        }
        self.definitions.lock().unwrap().clone()
    }

    fn call(&self, account: &str, name: &str, args: serde_json::Value) -> ToolFuture {
        if account != self.account {
            return Box::pin(async { Err("Wrong tool account".into()) });
        }
        if self
            .definitions
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.name == name && d.module.is_some())
        {
            return Box::pin(async {
                Err("Module tool execution arrives with the server bridge.".into())
            });
        }
        self.executor.call(account, name, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtins::{current_time, BuiltinTools};
    use serde_json::json;

    #[test]
    fn changes_include_schema_description_and_facts_but_not_order() {
        let first = current_time();
        let mut second = first.clone();
        second.name = "other".into();
        let tools = TurnTools::new(
            "a",
            vec![first.clone(), second.clone()],
            Arc::new(BuiltinTools),
        );
        assert!(!tools.replace(vec![second.clone(), first.clone()]));
        second.input_schema = json!({"type":"object", "properties":{"n":{"type":"number"}}});
        assert!(tools.replace(vec![first.clone(), second.clone()]));
        second.description = "Changed".into();
        assert!(tools.replace(vec![first.clone(), second.clone()]));
        second.facts.execution_auto = false;
        assert!(tools.replace(vec![first, second]));
        assert!(tools.replace(vec![]));
    }

    #[tokio::test]
    async fn a_turn_list_and_execution_do_not_cross_accounts() {
        let tools = TurnTools::new("a", vec![current_time()], Arc::new(BuiltinTools));
        assert_eq!(tools.tools("a").len(), 1);
        assert!(tools.tools("b").is_empty());
        assert!(tools.call("b", "current_time", json!({})).await.is_err());
    }
}
