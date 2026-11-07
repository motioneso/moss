use std::sync::Mutex;

use chrono::{Local, Timelike};

use crate::*;

pub struct StubShellData {
    messages: Mutex<Vec<ChatMessage>>,
}

impl Default for StubShellData {
    fn default() -> Self {
        Self {
            messages: Mutex::new(vec![ChatMessage {
                id: "m1".into(),
                role: ChatRole::Assistant,
                text: "Morning. Your day is light: one planning block and a call at two. \
                       I moved the grocery run to after the call so it doesn't clash."
                    .into(),
            }]),
        }
    }
}

fn link(path: &str, label: &str, icon: &str) -> NavLink {
    NavLink { path: path.into(), label: label.into(), icon: icon.into(), unread: 0 }
}

fn greeting() -> &'static str {
    match Local::now().hour() {
        5..=11 => "Good morning",
        12..=17 => "Good afternoon",
        _ => "Good evening",
    }
}

impl ShellData for StubShellData {
    fn shell(&self) -> ShellView {
        ShellView {
            assistant_name: "Moss".into(),
            account: Account { display_name: "Sam Rivera".into(), unread_notifications: 2 },
            nav: vec![
                NavSection {
                    label: None,
                    links: vec![
                        link("/today", "Today", "house"),
                        link("/workshop", "The Workshop", "wrench"),
                    ],
                },
                NavSection {
                    label: Some("Plan".into()),
                    links: vec![
                        link("/tasks", "Tasks", "square-check-big"),
                        link("/calendar", "Calendar", "calendar-days"),
                        link("/meetings", "Meetings", "mic"),
                    ],
                },
                NavSection {
                    label: Some("Your world".into()),
                    links: vec![
                        link("/news", "News", "newspaper"),
                        link("/sports", "Sports", "trophy"),
                        link("/wellness", "Wellness", "heart-pulse"),
                    ],
                },
            ],
            chat_unread: 1,
            sample_data: true,
        }
    }

    fn today(&self) -> TodayView {
        TodayView {
            hero: TodayHero {
                greeting: format!("{}, Sam", greeting()),
                headline: "A LIGHT".into(),
                headline_accent: "DAY".into(),
                summary: "Two things on the plan and 1 event on the calendar.".into(),
                weather_note: Some("Weather isn't set up yet.".into()),
                briefing_note: "Briefing not ready yet. Your morning briefing is switched off."
                    .into(),
            },
            timeline: vec![
                TimelineSlot {
                    kind: SlotKind::Committed,
                    start: "09:30".into(),
                    end: "10:30".into(),
                    title: "Plan the garden beds for spring".into(),
                    duration_minutes: 60,
                    detail: Some("Home".into()),
                },
                TimelineSlot {
                    kind: SlotKind::Event,
                    start: "14:00".into(),
                    end: "14:30".into(),
                    title: "Call with the plumber about the quote".into(),
                    duration_minutes: 30,
                    detail: Some("Phone".into()),
                },
                TimelineSlot {
                    kind: SlotKind::Proposed,
                    start: "15:00".into(),
                    end: "15:45".into(),
                    title: "Grocery run for the week".into(),
                    duration_minutes: 45,
                    detail: Some("Errands".into()),
                },
            ],
            timeline_closing: Some("The evening is open. No more commitments after 15:45.".into()),
            quick_actions: Some(QuickActionGroup {
                title: "Wellness".into(),
                actions: vec![
                    QuickAction {
                        label: "Medications".into(),
                        sub: None,
                        control: QuickActionControl::Add { label: "Log medication".into() },
                    },
                    QuickAction {
                        label: "Mood check-in".into(),
                        sub: Some("Record how you feel.".into()),
                        control: QuickActionControl::Button { text: "Check in".into() },
                    },
                ],
            }),
            quiet_line: Some(
                "Nothing else yet today: no briefing, nothing pressing, and no evening review."
                    .into(),
            ),
        }
    }

    fn chat_thread(&self) -> ChatThread {
        ChatThread {
            status: "Sample replies only".into(),
            model_label: "Sample model".into(),
            messages: self.messages.lock().expect("stub lock").clone(),
        }
    }

    fn send_message(&self, text: &str) -> ChatMessage {
        let mut messages = self.messages.lock().expect("stub lock");
        let n = messages.len();
        messages.push(ChatMessage {
            id: format!("m{}", n + 1),
            role: ChatRole::User,
            text: text.to_string(),
        });
        let reply = ChatMessage {
            id: format!("m{}", n + 2),
            role: ChatRole::Assistant,
            text: "This is a sample reply. Real answers arrive when the chat runner is ported."
                .into(),
        };
        messages.push(reply.clone());
        reply
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_appends_both_turns() {
        let data = StubShellData::default();
        let before = data.chat_thread().messages.len();
        let reply = data.send_message("hello");
        let thread = data.chat_thread();
        assert_eq!(thread.messages.len(), before + 2);
        assert_eq!(thread.messages[before].text, "hello");
        assert_eq!(thread.messages[before + 1], reply);
        assert_eq!(reply.role, ChatRole::Assistant);
    }

    #[test]
    fn shell_says_it_is_sample_data() {
        assert!(StubShellData::default().shell().sample_data);
    }
}
