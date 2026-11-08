use leptos::prelude::*;
use moss_calendar_ui::{
    model::{group, Event},
    views::{EventDetails, Month, ReadFailure},
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
    let output=view!{<Month cursor=day today=day events=group(&[event.clone()],chrono_tz::UTC) twelve=true on_day=Callback::new(|_|{}) on_event=Callback::new(|_|{})/>}.to_html();
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
    assert!(output.contains("Nov 8, 2026 – Nov 10, 2026"));
    assert!(!output.contains("Nov 7, 2026"));
    assert!(!output.contains("Nov 11, 2026"));
}

#[test]
fn unsaved_locale_uses_the_production_twenty_four_hour_clock() {
    assert!(!moss_calendar_ui::model::twelve(None));
    assert!(!moss_calendar_ui::model::twelve(Some("24")));
    assert!(moss_calendar_ui::model::twelve(Some("12")));
    assert_eq!(moss_calendar_ui::model::time(13 * 60 + 30, false), "13:30");
}
