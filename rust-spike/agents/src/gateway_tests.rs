use super::*;
use crate::builtins::{current_time, BuiltinTools};
use crate::runner::plain_facts;
use crate::turn_tools::TurnTools;
use tokio::time::{timeout, Duration};

fn deny() -> Confirm {
    Arc::new(|_, _| Box::pin(async { Answer::Deny }))
}

#[tokio::test]
async fn an_unoffered_tool_is_refused_before_execution() {
    let host = TurnTools::new("alice", vec![current_time()], Arc::new(BuiltinTools));
    let reply = call_tool(
        &host,
        &deny(),
        &plain_facts(),
        "bob",
        "current_time",
        json!({}),
    )
    .await;
    assert_eq!(reply["isError"], true);
    let reply = call_tool(
        &host,
        &deny(),
        &plain_facts(),
        "alice",
        "unoffered",
        json!({}),
    )
    .await;
    assert_eq!(reply["isError"], true);
}

#[tokio::test]
async fn socket_reply_ids_and_idle_list_change_push_share_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let host = Arc::new(TurnTools::new(
        "alice",
        vec![current_time()],
        Arc::new(BuiltinTools),
    ));
    let gateway =
        GatewayHost::start("alice", dir.path(), host.clone(), deny(), plain_facts()).unwrap();
    let stream = tokio::net::UnixStream::connect(&gateway.socket)
        .await
        .unwrap();
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let lease = std::fs::read_to_string(&gateway.lease_file).unwrap();
    write
        .write_all(format!("{}\n", json!({"op":"hello", "lease":lease})).as_bytes())
        .await
        .unwrap();
    assert_eq!(lines.next_line().await.unwrap().unwrap(), "{\"ok\":true}");
    write
        .write_all(b"{\"op\":\"list\",\"id\":71}\n")
        .await
        .unwrap();
    let listed: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(listed["id"], 71);
    assert_eq!(listed["tools"][0]["name"], "current_time");
    host.replace(vec![]);
    gateway.tools_changed();
    let pushed: Value = serde_json::from_str(
        &timeout(Duration::from_secs(2), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(pushed, json!({"event":"list_changed"}));
    write
        .write_all(b"{\"op\":\"list\",\"id\":72}\n")
        .await
        .unwrap();
    let listed: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(listed, json!({"id":72,"tools":[]}));
}

#[tokio::test]
async fn wrong_gateway_lease_cannot_list_tools() {
    let (client, server) = tokio::net::UnixStream::pair().unwrap();
    let (_changed, changes) = tokio::sync::watch::channel(0);
    let task = tokio::spawn(async move {
        serve_one(
            server,
            "expected",
            "alice",
            Arc::new(BuiltinTools),
            deny(),
            plain_facts(),
            changes,
        )
        .await
        .unwrap();
    });
    let (read, mut write) = client.into_split();
    write
        .write_all(b"{\"op\":\"hello\",\"lease\":\"wrong\"}\n{\"op\":\"list\",\"id\":1}\n")
        .await
        .unwrap();
    write.shutdown().await.unwrap();
    let mut lines = BufReader::new(read).lines();
    assert!(
        lines.next_line().await.unwrap().is_none(),
        "wrong lease opened the gateway"
    );
    task.await.unwrap();
}
