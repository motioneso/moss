use leptos::prelude::*;
use moss_calendar_ui::{
    model::{group, Event},
    views::{CalendarLegend, EventDetails, Month, ReadFailure},
};

#[test]
fn month_escapes_private_event_text() {
    let event = Event {
        id: "event".into(),
        title: "<script>private</script>".into(),
        starts_at: "2026-11-08T10:00:00Z".into(),
        ends_at: "2026-11-08T11:00:00Z".into(),
        all_day: false,
        is_moss_block: false,
        location: None,
        attendee_count: 0.0,
        status: None,
        read_only: true,
        unconfirmed: true,
    };
    let day = "2026-11-08".parse().unwrap();
    let output=view!{<Month cursor=day today=day events=group(std::slice::from_ref(&event),chrono_tz::UTC) twelve=true on_day=Callback::new(|_|{}) on_event=Callback::new(|_|{})/>}.to_html();
    assert!(output.contains("&lt;script&gt;private&lt;/script&gt;"));
    assert!(!output.contains("<script>private"));
    assert!(output.contains("cal-mchip"));
    assert!(output.contains("10 AM"));
    let details = view!{<EventDetails event=event timezone="UTC".to_string() twelve=true on_close=Callback::new(|_|{})/>}.to_html();
    assert!(details.contains("Needs verification in Outlook"));
    assert!(details.contains("Read only"));
    assert!(details.contains("Event details"));
    assert!(details.contains("&lt;script&gt;private&lt;/script&gt;"));
}
#[test]
fn failed_refresh_discloses_retained_data_and_offers_retry() {
    let output = view! {<ReadFailure retained=true on_retry=Callback::new(|_|{})/>}.to_html();
    assert!(output.contains("Previously loaded events are still shown"));
    assert!(output.contains("Try again"));
    assert!(output.contains("role=\"alert\""));
}

#[test]
fn all_day_details_keep_calendar_dates_and_remove_the_exclusive_end() {
    let event: Event = serde_json::from_value(serde_json::json!({
        "id":"all-day", "title":"Trip", "allDay":true,
        "startsAt":"2026-11-08T00:00:00Z", "endsAt":"2026-11-11T00:00:00Z"
    }))
    .unwrap();
    let output = view!{<EventDetails event=event timezone="America/Los_Angeles".to_string() twelve=true on_close=Callback::new(|_|{})/>}.to_html();
    assert!(output.contains("All day"));
    assert!(output.contains("Sunday, November 8 – Tuesday, November 10"));
    assert!(!output.contains("November 7"));
    assert!(!output.contains("November 11"));
}

#[test]
fn unsaved_locale_uses_the_production_twenty_four_hour_clock() {
    assert!(!moss_calendar_ui::model::twelve(None));
    assert!(!moss_calendar_ui::model::twelve(Some("24")));
    assert!(moss_calendar_ui::model::twelve(Some("12")));
    assert_eq!(moss_calendar_ui::model::time(13 * 60 + 30, false), "13:30");
}

#[test]
fn event_details_keep_duration_attendee_grammar_and_status() {
    for (count, expected) in [(1, "1 person"), (2, "2 people")] {
        let event: Event = serde_json::from_value(serde_json::json!({
            "id":"meeting", "title":"Review", "startsAt":"2026-11-08T10:00:00Z",
            "endsAt":"2026-11-08T11:30:00Z", "attendeeCount":count
        }))
        .unwrap();
        let output = view!{<EventDetails event=event timezone="UTC".to_string() twelve=false on_close=Callback::new(|_|{})/>}.to_html();
        assert!(
            output.contains("1 hr 30 min"),
            "Duration is missing: {output}"
        );
        assert!(output.contains(expected), "Attendee grammar is missing");
        assert!(output.contains("Accepted"), "Event status is missing");
    }
}

#[test]
fn event_details_distinguish_rsvp_observation_and_held_blocks() {
    for (metadata, label) in [
        (serde_json::json!({"status":"tentative"}), "Pending RSVP"),
        (serde_json::json!({"status":"needsAction"}), "Pending RSVP"),
        (serde_json::json!({"readOnly":true}), "Observed in Outlook"),
        (
            serde_json::json!({"readOnly":true,"unconfirmed":true}),
            "Needs verification",
        ),
        (serde_json::json!({"isMossBlock":true}), "Moss focus block"),
    ] {
        let mut value = serde_json::json!({"id":"event","title":"Meeting", "startsAt":"2026-11-08T10:00:00Z", "endsAt":"2026-11-08T11:00:00Z"});
        value
            .as_object_mut()
            .unwrap()
            .extend(metadata.as_object().unwrap().clone());
        let event: Event = serde_json::from_value(value).unwrap();
        let output = view!{<EventDetails event=event timezone="UTC".to_string() twelve=false on_close=Callback::new(|_|{})/>}.to_html();
        assert!(output.contains(label), "Missing {label}");
    }
}

#[test]
fn held_event_text_uses_the_account_name_and_escapes_it() {
    let event: Event = serde_json::from_value(serde_json::json!({
        "id":"block", "title":"Focus", "isMossBlock":true,
        "startsAt":"2026-11-08T10:00:00Z", "endsAt":"2026-11-08T11:00:00Z"
    }))
    .unwrap();
    let output = view! {<EventDetails event=event timezone="UTC".to_string() twelve=false
    assistant_name="Cedar & Co".to_string() on_close=Callback::new(|_|{})/>}
    .to_html();
    for text in [
        "Cedar &amp; Co is holding this",
        "Cedar &amp; Co focus block",
        "Cedar &amp; Co can move or shorten this block",
    ] {
        assert!(
            output.contains(text),
            "Missing personalized wording: {text}"
        );
    }
    assert!(!output.contains("Moss"));
}

#[test]
fn midnight_end_does_not_add_a_day_to_event_details() {
    let event: Event = serde_json::from_value(serde_json::json!({
        "id":"midnight", "title":"Late meeting", "startsAt":"2026-11-08T22:30:00Z",
        "endsAt":"2026-11-09T00:00:00Z"
    }))
    .unwrap();
    let output = view!{<EventDetails event=event timezone="UTC".to_string() twelve=false on_close=Callback::new(|_|{})/>}.to_html();
    assert!(
        output.contains("Sunday, November 8"),
        "Missing original date label: {output}"
    );
    assert!(
        !output.contains("November 9") && !output.contains("Nov 9"),
        "Midnight end adds an extra day: {output}"
    );
}

#[test]
fn legend_only_counts_held_blocks_on_today_in_day_view() {
    let today = "2026-11-08".parse().unwrap();
    for (view, day, held, note) in [
        ("day", today, 1, "1 flexible block today."),
        ("day", today, 2, "2 flexible blocks today."),
        ("day", today, 0, ""),
        ("day", "2026-11-09".parse().unwrap(), 2, ""),
        ("week", today, 2, ""),
        ("month", today, 2, ""),
    ] {
        let output = view!{<CalendarLegend view=view.to_string() day=day today=today held=held assistant_name="<Helper>".to_string()/>}.to_html();
        assert_eq!(output.contains("cal-legend__note"), !note.is_empty());
        if !note.is_empty() {
            assert!(output.contains(note));
        }
        if view == "month" {
            assert!(!output.contains("cal-legend"));
        } else {
            assert!(output.contains("&lt;Helper&gt; holding"));
            assert!(output.contains("cal-legend__sw--hard"));
            assert!(output.contains("cal-legend__sw--hold"));
        }
    }
}
