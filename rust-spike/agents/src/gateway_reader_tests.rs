use super::*;

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);
impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn reader_routes_out_of_order_replies_and_pushes_without_consuming_an_answer() {
    let pending = Pending::default();
    let (one, rx_one) = mpsc::channel();
    let (two, rx_two) = mpsc::channel();
    pending.lock().unwrap().replies.extend([(1, one), (2, two)]);
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let output: Output = Arc::new(Mutex::new(Box::new(Capture(bytes.clone()))));
    read_replies(
        std::io::Cursor::new(concat!(
            "{\"id\":99,\"text\":\"stale\"}\n",
            "{\"event\":\"list_changed\"}\n",
            "{\"id\":2,\"text\":\"second\"}\n",
            "{\"event\":\"list_changed\"}\n",
            "{\"id\":1,\"text\":\"first\"}\n"
        )),
        pending.clone(),
        output,
        Arc::new(AtomicBool::new(true)),
    );
    assert_eq!(rx_one.recv().unwrap()["text"], "first");
    assert_eq!(rx_two.recv().unwrap()["text"], "second");
    let data = bytes.lock().unwrap();
    let notices: Vec<Value> = std::str::from_utf8(&data)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(notices.len(), 2);
    assert!(notices
        .iter()
        .all(|v| v["method"] == "notifications/tools/list_changed" && v.get("id").is_none()));
    assert!(pending.lock().unwrap().replies.is_empty());
}

#[test]
fn disconnect_wakes_waiters_and_preinitialize_pushes_are_not_emitted() {
    let pending = Pending::default();
    let (tx, rx) = mpsc::channel();
    pending.lock().unwrap().register(1, tx).unwrap();
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let output: Output = Arc::new(Mutex::new(Box::new(Capture(bytes.clone()))));
    read_replies(
        std::io::Cursor::new("{\"event\":\"list_changed\"}\n"),
        pending.clone(),
        output,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(rx.recv().is_err());
    assert!(bytes.lock().unwrap().is_empty());
    let (tx, late) = mpsc::channel();
    assert!(pending.lock().unwrap().register(2, tx).is_err());
    assert!(late.recv().is_err(), "a request after EOF must not wait forever");
}
