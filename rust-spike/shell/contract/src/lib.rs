//! What the UI shell asks the server for, and the seam the core platform fills in.
//!
//! The browser build and the desktop window both read these shapes as JSON from the same
//! server. `ShellData` is the server-side seam: Phase 0 ships `StubShellData`, and Phase 2/3
//! replace it with an implementation backed by the database and the chat runner.

use serde::{Deserialize, Serialize};

/// Signed-in account as the frame shows it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Account {
    pub display_name: String,
    pub unread_notifications: u32,
}

/// One entry in the main navigation.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NavLink {
    pub path: String,
    pub label: String,
    /// Icon name from the shell's icon set, for example `house` or `calendar-days`.
    pub icon: String,
    pub unread: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NavSection {
    /// `None` for the unlabelled first group.
    pub label: Option<String>,
    pub links: Vec<NavLink>,
}

/// Everything the frame needs before any screen draws.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ShellView {
    pub assistant_name: String,
    pub account: Account,
    pub nav: Vec<NavSection>,
    pub chat_unread: u32,
    /// True while the data comes from `StubShellData`. The frame says so on screen.
    pub sample_data: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TodayHero {
    pub greeting: String,
    pub headline: String,
    pub headline_accent: String,
    pub summary: String,
    /// Shown when weather is not set up or not available.
    pub weather_note: Option<String>,
    pub briefing_note: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlotKind {
    /// A calendar commitment.
    Event,
    /// A task Moss placed on the day plan and the person kept.
    Committed,
    /// A task Moss suggests but the person has not kept yet.
    Proposed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TimelineSlot {
    pub kind: SlotKind,
    /// Local wall-clock times, already formatted ("09:30").
    pub start: String,
    pub end: String,
    pub title: String,
    pub duration_minutes: u32,
    /// Where an event happens, or a short task source label.
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum QuickActionControl {
    /// A small "+" icon button with this accessible label.
    Add { label: String },
    /// A primary button with this text.
    Button { text: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuickAction {
    pub label: String,
    pub sub: Option<String>,
    pub control: QuickActionControl,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuickActionGroup {
    pub title: String,
    pub actions: Vec<QuickAction>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TodayView {
    pub hero: TodayHero,
    pub timeline: Vec<TimelineSlot>,
    pub timeline_closing: Option<String>,
    pub quick_actions: Option<QuickActionGroup>,
    pub quiet_line: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChatThread {
    pub status: String,
    pub model_label: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SendMessage {
    pub text: String,
}

/// The seam Phase 2/3 fill in. Each call is made on behalf of one signed-in account.
pub trait ShellData: Send + Sync + 'static {
    fn shell(&self) -> ShellView;
    fn today(&self) -> TodayView;
    fn chat_thread(&self) -> ChatThread;
    /// Stores the person's message and returns the assistant's reply.
    fn send_message(&self, text: &str) -> ChatMessage;
}

/// Fixed sample data, so the frame and the first two screens can be built and checked before
/// the database and chat runner exist. Every word here is invented; nothing is personal.
#[cfg(feature = "stub")]
pub mod stub;
