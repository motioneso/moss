//! Prints the confinement rules the runner gives one account's agent, one argument per line,
//! so `proof/containment.sh` probes exactly what the runner launches.
//!
//!   launch-rules <root> <account> <sign-in-home> <program> <gateway-bin> <confine-bin>

use std::sync::Arc;

use moss_agents::driver::{AgentKind, ToolServer};
use moss_agents::gateway::{ToolDef, ToolFuture, ToolHost};
use moss_agents::runner::*;
use serde_json::Value;

struct NoTools;
impl ToolHost for NoTools {
    fn tools(&self) -> Vec<ToolDef> {
        vec![]
    }
    fn call(&self, _: &str, _: &str, _: Value) -> ToolFuture {
        Box::pin(async { Err("none".into()) })
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let [root, account, home, program, gateway, confine] = &a[..] else {
        eprintln!("usage: launch-rules <root> <account> <sign-in-home> <program> <gateway-bin> <confine-bin>");
        std::process::exit(2);
    };
    let r = Runner::new(
        RunnerConfig {
            root: root.into(),
            gateway_bin: gateway.into(),
            confine_bin: Some(confine.into()),
        },
        Arc::new(NoTools),
        plain_facts(),
    );
    let setup = AccountSetup {
        kind: AgentKind::Claude,
        program: program.into(),
        sign_in_home: home.into(),
        model: None,
    };
    let tools = ToolServer {
        command: gateway.into(),
        args: vec![],
        env: vec![],
    };
    let spec = r.launch_spec(&setup, &r.folders(account), tools);
    let (_, args) = spec.confinement.expect("confined").wrap(&spec.program, &[]);
    for arg in args.iter().take_while(|a| *a != "--") {
        println!("{arg}");
    }
}
