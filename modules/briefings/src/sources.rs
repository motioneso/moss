//! Sources a briefing may select. The list is the read-risk assistant tools of the old app plus
//! the two virtual sources. `tools/read-tools.ts` prints it again from the old catalogue.
pub const VIRTUAL: [&str; 2] = ["vault", "chats"];

pub const READ_TOOLS: [&str; 59] = [
    "ai.explainRecentErrors",
    "app.findAction",
    "app.getMapSlice",
    "app.readSource",
    "briefings.getRunStatus",
    "calendar.heartbeatWindow",
    "calendar.listLiveEvents",
    "calendar.listVisibleEvents",
    "chat.getCurrentTime",
    "chat.getCurrentView",
    "chat.listTodaysTurns",
    "chat.present",
    "chat.readAttachment",
    "chat.remindersSummary",
    "commitments.get",
    "commitments.heartbeatOpen",
    "commitments.list",
    "commitments.listVisible",
    "commitments.threadJudgements",
    "connectors.startGoogleGuidance",
    "email.listVisibleMessages",
    "gmail.getLiveMessage",
    "gmail.searchLive",
    "goals.get",
    "goals.list",
    "memory.recall",
    "news.credentialedSourceStatus",
    "news.heartbeatHeadlines",
    "news.previewSource",
    "news.topHeadlinesToday",
    "notes.search",
    "notifications.listVisible",
    "people.getContext",
    "people.listRecent",
    "people.resolve",
    "scratchpad.read",
    "settings.platformDiagnostics",
    "sports.followedFactsToday",
    "sports.heartbeatNextFixtures",
    "sports.latestResult",
    "sports.listSources",
    "sports.previewSource",
    "sports.previewSourceAssignments",
    "sports.rebuildSourceRecipe",
    "tasks.activity",
    "tasks.atRisk",
    "tasks.focus",
    "tasks.get",
    "tasks.heartbeatWindow",
    "tasks.list",
    "tasks.listLists",
    "tasks.listTags",
    "tasks.overdue",
    "tasks.summary",
    "weather.forecast",
    "web.read",
    "web.search",
    "wellness.medicationAdherence",
    "wellness.recentCheckIns",
];

pub fn allowed(name: &str) -> bool {
    VIRTUAL.contains(&name) || READ_TOOLS.contains(&name)
}

/// Default selection for each briefing type.
pub fn defaults(kind: &str) -> Vec<&'static str> {
    match kind {
        "evening" => vec![
            "tasks.list",
            "calendar.listVisibleEvents",
            "email.listVisibleMessages",
            "chat.listTodaysTurns",
            "goals.list",
            "sports.followedFactsToday",
        ],
        "weekly_review" => vec![
            "tasks.list",
            "calendar.listVisibleEvents",
            "email.listVisibleMessages",
            "vault",
            "goals.list",
        ],
        _ => vec![
            "tasks.list",
            "calendar.listVisibleEvents",
            "email.listVisibleMessages",
            "vault",
            "goals.list",
            "news.topHeadlinesToday",
            "sports.followedFactsToday",
        ],
    }
}
