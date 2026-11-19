use super::*;
use std::time::Duration;

fn record(actor: &str, turn: &str, kind: ApprovalKind, runner_id: u64) -> Record {
    Record {
        id: Uuid::new_v4(),
        actor: actor.into(),
        turn: turn.into(),
        kind,
        runner_id,
        title: "t".into(),
        fields: vec![],
        expires: Instant::now() + Duration::from_secs(600),
        state: ApprovalState::Pending,
    }
}

fn book_with(r: Record) -> (Book, String) {
    let id = r.id.to_string();
    let mut book = Book::default();
    book.add(r);
    (book, id)
}

#[test]
fn another_account_cannot_answer_an_approval_and_sees_it_as_unknown() {
    let (mut book, id) = book_with(record("alice", "t1", ApprovalKind::Permission, 7));
    assert_eq!(
        book.decide("bob", &id, Decision::Approve),
        Err(ChatError::NotFound)
    );
    assert!(book.views("bob").is_empty());
    // The refused attempt left the record pending for its owner.
    assert_eq!(book.views("alice")[0].state, ApprovalState::Pending);
    assert_eq!(book.decide("alice", &id, Decision::Approve), Ok((7, true)));
}

#[test]
fn an_approval_is_answered_once() {
    let (mut book, id) = book_with(record("alice", "t1", ApprovalKind::Permission, 7));
    assert_eq!(book.decide("alice", &id, Decision::Reject), Ok((7, false)));
    assert_eq!(
        book.decide("alice", &id, Decision::Approve),
        Err(ChatError::Closed)
    );
    assert_eq!(book.views("alice")[0].state, ApprovalState::Declined);
}

#[test]
fn approved_permission_is_used_up_and_approved_action_waits_for_its_call() {
    let (mut book, id) = book_with(record("a", "t1", ApprovalKind::Permission, 1));
    book.decide("a", &id, Decision::Approve).unwrap();
    assert_eq!(book.views("a")[0].state, ApprovalState::Used);
    let (mut book, id) = book_with(record("a", "t1", ApprovalKind::Action, 1));
    book.decide("a", &id, Decision::Approve).unwrap();
    assert_eq!(book.views("a")[0].state, ApprovalState::Approved);
}

#[test]
fn no_approval_outlives_its_turn() {
    let (mut book, id) = book_with(record("a", "t1", ApprovalKind::Permission, 1));
    let (mut approved, approved_id) = book_with(record("a", "t1", ApprovalKind::Action, 2));
    approved.decide("a", &approved_id, Decision::Approve).unwrap();
    let mut other = record("a", "t2", ApprovalKind::Permission, 3);
    other.expires = Instant::now() + Duration::from_secs(600);
    book.add(other);
    book.void_turn("t1");
    approved.void_turn("t1");
    assert_eq!(
        book.decide("a", &id, Decision::Approve),
        Err(ChatError::Closed)
    );
    assert_eq!(approved.views("a")[0].state, ApprovalState::Voided);
    // A different turn's record is untouched.
    assert_eq!(book.views("a")[1].state, ApprovalState::Pending);
}

#[test]
fn expiry_times_out_only_pending_records_past_their_deadline() {
    let mut late = record("a", "t", ApprovalKind::Permission, 1);
    late.expires = Instant::now() - Duration::from_secs(1);
    let id = late.id.to_string();
    let mut book = Book::default();
    book.add(late);
    book.add(record("a", "t", ApprovalKind::Permission, 2));
    assert_eq!(book.expire(Instant::now()), vec![1]);
    assert_eq!(book.expire(Instant::now()), Vec::<u64>::new());
    assert_eq!(
        book.decide("a", &id, Decision::Approve),
        Err(ChatError::Closed)
    );
}

#[test]
fn the_card_title_is_fixed_and_agent_text_is_a_capped_field_value() {
    let fields = permission_fields("Bash", &serde_json::json!({"command": "ls ".repeat(400)}));
    assert_eq!(fields[0].label, "Tool");
    let command = fields.iter().find(|f| f.label == "Command").unwrap();
    assert!(command.value.chars().count() <= FIELD_CAP + 1);
    assert_eq!(PERMISSION_TITLE, "Permission request");
    let secret = permission_fields(
        "Bash",
        &serde_json::json!({"command": "curl -H token=abcdefghijklmnopqrstuvwxyz0123456789 x"}),
    );
    assert!(!secret[1].value.contains("abcdefghijklmnop"));
}

#[test]
fn views_never_carry_raw_parameters() {
    let json = serde_json::to_string(
        &book_with(record("a", "t", ApprovalKind::Permission, 1))
            .0
            .views("a"),
    )
    .unwrap();
    assert!(!json.contains("runner_id") && !json.contains("input"));
}
