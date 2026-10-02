import type { AiModelCapability, AiModelTier } from "./ai-types.js";

export interface CoreAppSurfaceDeclaration {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly path: string;
  readonly scope: "user" | "admin";
}

export interface CoreAppErrorDeclaration {
  readonly code: string;
  readonly class: "prerequisite" | "transient" | "validation" | "permission" | "bug";
  readonly remediationRef?: string;
  readonly description: string;
}

export interface CoreAppRemediationDeclaration {
  readonly id: string;
  readonly description: string;
  readonly path?: string;
  readonly scope?: "user" | "admin" | "system";
}

export interface AppMapItem {
  readonly moduleId: string;
  readonly id?: string;
  readonly featureId?: string;
  readonly code?: string;
  readonly class?: "prerequisite" | "transient" | "validation" | "permission" | "bug";
  readonly remediationRef?: string;
  readonly label?: string;
  readonly description?: string;
  readonly path?: string;
  readonly scope?: "user" | "admin" | "system";
  readonly featureFlagId?: string;
  readonly requires?: {
    readonly service: string;
    readonly capability: AiModelCapability;
    readonly tier: AiModelTier;
  };
}

export interface AppMapArtifact {
  readonly schemaVersion: 1;
  readonly build: { readonly version: string; readonly buildId: string };
  readonly screens: readonly AppMapItem[];
  readonly settings: readonly AppMapItem[];
  readonly features: readonly AppMapItem[];
  readonly errors: readonly AppMapItem[];
  readonly remediations: readonly AppMapItem[];
  readonly narrative: { readonly authoritative: false; readonly markdown: string };
}

export const CORE_APP_SCREENS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "today",
    label: "Today",
    description:
      "Read the saved day plan as a schedule and preparation list with each block's state in words (committed versus proposed), plus a prominent weather row, a quick-actions dock with slot-placed module widgets, task and event details, email action rows, and goals. Needs You shows active action rows and visible Loose ends together in a labelled group, with both included in its count; Catch-up is a compact informational summary outside that count, and View appears only when an action row already has a supported source link. Today previews the briefing lead; the full reader shows the source-grounded report as a headline line, a two-to-three sentence lead, and sections headed by what to do that walk through the day's events in time order with their times and places, what to prepare or bring, and today's forecast, plus priorities, verified changes and follow-up where available, plus a What informed this briefing block naming each source in plain words (such as Today's schedule, Weather, Tonight and tomorrow, Today's email, This morning's plan and Task review) with its time and a short line on what it contributed, such as a count of events, emails read or tasks reviewed, with no line when a source was empty or failed and plain source names in the No longer available notes below the list, and earlier reports, naming overnight changes to the saved evening plan. If a morning run fails, the reader can retry it, shows the new run as pending, and displays its result when ready. When no evening priorities are available, it explains that today's available sources, including tasks and calendar, shaped the report; a delayed email source names its last update and possible unseen replies. When the email source is over a day old, Today shows a Refresh email action beside Read the full morning briefing, outside the reader; it starts one updated briefing only after email refresh succeeds or partially succeeds and retains the current report and plan choices if refresh or briefing preparation fails. A Review task blocks button opens per-block placement and time choices with preview, one confirmation for moves and removals, and per-item outcomes. An Accept all time blocks button in the reader and the review applies every eligible proposed addition in one activation. A Plan tomorrow button opens an evening planning dialog with reflect, commitment, shape and review sections that saves tomorrow's intent and draft blocks in one action. The reflect section shows the latest evening report formatted like the reader, with its section headings, paragraphs and lists, above the reply choices. Light considers one priority block, a steady day considers the main task plus one follow-through block, and Full day considers all selected commitments while using open time. Unsaved placement choices immediately appear under Proposed calendar changes before the plan is saved. In the Plan tomorrow side column, a Room to get home and have lunch note appears only when at least an hour is free between the last calendar entry and the first proposed block, an N minutes between task blocks note appears only when every gap between proposed blocks is the same, and Moss task blocks already on tomorrow's calendar sit in an Existing calendar task blocks fold instead of the main list unless automatic scheduling is on. A Chat with Moss button on the same card opens the evening interview carrying the saved plan, and can save intent and untimed additions for review without ever writing to the calendar. When the calendar or the saved plan cannot be read the schedule says so plainly instead of showing an empty day, and loaded events stay visible while the plan is still arriving. On Today's schedule, a Moss-planned block already on the calendar carries a Flexible tag, a block Moss is suggesting for the first time says Proposed, and a preparation block that ends right when a calendar event starts adds a line naming that event and its time (no line appears when no event backs one). The schedule also shows the gaps between blocks and commitments as a break or as open time, and a closing line once the day's commitments are done; all of it comes only from the times already on the schedule. A First meeting card names the day's first meeting, its length and place, and adds a preparation line only when a real calendar block immediately before it is itself titled as preparation; a See meeting button opens that exact meeting on the calendar screen. Below it, a Since last night section appears only when a block in today's plan moved since the morning report was prepared, naming the block and its old and new time. Under it, a practical note (A little practical context) names the next later event today that has a place, with its title, start time and place, and never guesses a leave time or travel time; it appears only when a timed calendar event later today has a place, and is absent otherwise. The side column has no preparation list because no source links materials to a meeting, and it no longer repeats the day's counts or agenda. After the evening briefing time, the Today page drops the schedule section and the header shows the evening report's opening verdict with Read the full evening briefing, which opens the latest evening report in the full reader labelled Evening briefing, and What informed this?, which opens the same reader with its source list expanded; the evening reader has no task-block review or footer actions, and a failed evening run can be retried from it. What happened today opens with the report's What got done prose, and Close the open loops opens with its Carrying forward prose, then lists each open task with a reason line taken from its due date (no reason line when it has no due date) and three choices, Tomorrow, Choose a day and Let it go, which move its due date or archive it, and shows \"Nothing needs a decision tonight.\" when nothing is carrying forward; if saving a choice fails, the task keeps its three choices and shows \"Could not save that. Try again.\", and pressing a choice again retries; each part appears once, and a slot whose section is missing stays empty. Under What happened today, each finished task shows its own description as a note, or the time it was completed when it has no description, and no note when it has neither. The header and the reader both show when the report was prepared as a 12-hour time with am or pm for English regions (for example Prepared at 8:00 am), taken from the saved run time and shown in the person's own time zone; other regions see their own localized time. The header has no decorative contour texture.",
    path: "/today",
    scope: "user"
  },
  {
    id: "notifications",
    label: "Notifications",
    description:
      "Review notifications produced by enabled modules. The account menu button at the bottom of the rail shows the unread count as a badge when the menu is closed, and screen readers hear the number as part of the button's spoken label.",
    path: "/notifications",
    scope: "user"
  },
  {
    id: "settings",
    label: "Settings",
    description:
      "Personal and admin settings. A search box on the top bar matches section names, descriptions and common setting words, and also matches every installed module that has its own settings to open (for example News) by that module's name, description, and the name of each individual setting or credential it declares (for example, searching a credential's own name like \"Plaid\" finds the module that uses it). A module with nothing to configure is left out of the results. Picking a result jumps straight to that module's settings.",
    path: "/settings",
    scope: "user"
  },
  {
    id: "link-trail-marker",
    label: "Link a Mac",
    description:
      "Approve or decline a Mac asking to connect to this account. The Mac opens this screen with a request code in the address; the page names the Mac that is waiting and lists what a linked Mac will be able to do (check in and rename itself, read which focus block is on now, report which app is in front while one is on, and receive a nudge decision) and says it never receives the account password or browser session. Approving links it and it then appears under Active sessions in Account & preferences, where it can be signed out. A request expires after ten minutes, and an expired, already-answered or unknown request says so and asks the person to start again from the Mac.",
    path: "/link/trail-marker",
    scope: "user"
  }
];

// Mirrors the real PERSONAL_GROUPS/ADMIN_GROUPS section ids and labels declared in
// apps/web/src/settings/settings-page.tsx — kept truthful to that file rather than
// any earlier draft, per #1110 spec anti-hallucination (settings-page.tsx is the
// source of truth for what a user can actually reach).
export const CORE_APP_SETTINGS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "profile",
    label: "Account & preferences",
    description:
      "Edit personal profile and account details, time zone, date format, weather unit (Fahrenheit unless changed) and weather location (use the browser's location or search for a place; the hint under the location notes which of those two was used this session), quiet hours, sessions, data export and account deletion. A Trail Marker for Mac group explains the menu-bar Mac companion, says the app is not available to download yet, says what to enter in Trail Marker to connect (this site's address), describes how browser approval links a Mac and what the linked Mac may do, and points at Active sessions as the place a linked Mac appears and can be signed out. Active sessions lists a linked Mac by the name it gave, with its app version. About the Mac app itself (not shown on this page): Trail Marker only takes a picture of the exact window in front, and only when Accessibility is granted so it can identify that window (if it can't, it takes none; remedy: grant Trail Marker Accessibility in the Mac's System Settings); its menu's Pause All pauses everything and sends nothing at all (its Test vision button then says to resume first), and a Focus switch in the menu pauses just Focus while staying connected (Test vision then says to switch Focus back on); logging out, or Moss revoking the Mac, clears its Focus settings on that Mac.",
    path: "/settings?section=profile",
    scope: "user"
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Choose the app theme and palette.",
    path: "/settings?section=appearance",
    scope: "user"
  },
  {
    id: "assistant",
    label: "Assistant & AI",
    description:
      "Change the AI model for chat: choose which model answers, change model routing and response behavior. When YOLO is active for your account, agent tool requests eligible for approval run without a confirmation card and are recorded as YOLO in Activity. Unknown, unavailable, malformed, and forbidden-path requests remain refused. Turning YOLO off restores confirmation for the next eligible request. Also choose assistant behavior and response style (concise, balanced, or detailed, each shown with an example answer of that length) available to this user. Write the persona as free text or set it with guided dials. The preview area invites the user to press Preview until a real reply comes back, and shows the invitation again after the persona text, dials, or assistant name change. Preview a response with the selected chat provider; a CLI preview requires a supported ACP agent and a working sign-in and runner connection, which an admin can check in Admin > Assistant & AI. Selecting a Codex model clears a saved OpenCode chat choice. When a default chat model is set, a note explains that an admin must add a transcription model (in Admin > Assistant & AI) to turn on the microphone in chat.",
    path: "/settings?section=assistant",
    scope: "user"
  },
  {
    id: "priorities",
    label: "Priorities",
    description: "Set goals and commitments the assistant should prioritize.",
    path: "/settings?section=priorities",
    scope: "user"
  },
  {
    id: "memory",
    label: "Memory & context",
    description:
      "Review and configure assistant memory behaviour, and choose the People folder. Every " +
      "folder is chosen from the same list of available folders, and People notes live inside " +
      "the chosen notes folder.",
    path: "/settings?section=memory",
    scope: "user"
  },
  {
    id: "activity",
    label: "Activity",
    description:
      "Review assistant activity visible to this user, including how long each action took to " +
      "run and, for repeated integration requests, whether a call was skipped because it was " +
      "already covered or refused for asking too fast.",
    path: "/settings?section=activity",
    scope: "user"
  },
  {
    id: "released",
    label: "Recently Released",
    description: "See what was added, fixed, and changed in recent Moss releases.",
    path: "/settings?section=released",
    scope: "user"
  },
  {
    id: "connected",
    label: "Connected accounts",
    description:
      "Connect external accounts and review their status. Add an email account by typing its address; Yahoo Mail, Proton Mail, iCloud and Fastmail addresses are recognised and get their mail server settings and app-password instructions filled in, other addresses choose the mail service by hand.",
    path: "/settings?section=connected",
    scope: "user"
  },
  {
    id: "sources",
    label: "Data sources",
    description:
      "Review sources the assistant can read and choose the notes folder. Every folder comes " +
      "from the same list of folders available on the server, and People notes live inside " +
      "the chosen notes folder. An info icon explains how folders get listed.",
    path: "/settings?section=sources",
    scope: "user"
  },
  {
    id: "integrations",
    label: "Integrations",
    description: "Connect external tools and services.",
    path: "/settings?section=integrations",
    scope: "user"
  },
  {
    id: "modules",
    label: "Modules",
    description: "Enable or disable user-toggleable modules.",
    path: "/settings?section=modules",
    scope: "user"
  },
  {
    id: "skills",
    label: "Skills",
    description: "Manage assistant skill instructions.",
    path: "/settings?section=skills",
    scope: "user"
  },
  {
    id: "people",
    label: "People & access",
    description: "Manage instance users, access, and registration policy.",
    path: "/settings?section=people",
    scope: "admin"
  },
  {
    id: "aiproviders",
    label: "Assistant & AI",
    description:
      "Configure instance AI providers, models, and bindings. Each provider card lists its models " +
      "with a Refresh models button (asks the provider for its current list; the line under the " +
      "list then reads 'Refreshed: N models', 'Not logged in', 'This provider cannot list its " +
      "models yet', 'The sign-in helper is not running', 'The provider rejected the API key', or 'Could not reach the provider') and an " +
      "Add model button (type in a model by hand; such rows show a * after the id, the footer " +
      "reads '* Manually added', and they survive refreshes and re-logins). System One (TypeSafe) " +
      "is offered as a provider type; it answers fixed named questions and is used only for the " +
      "Trail Marker focus judgment and the story and email sorting questions, not chat: its models are " +
      "offered only in the Classifier row and its card has no Set as default button. The " +
      "Classifier row also sets the model " +
      "that judges Trail Marker focus; nothing is judged until an admin chooses one there. Once " +
      "one is chosen it says Trail Marker's app and window titles also go to that model, or for " +
      "a System One model that they go to TypeSafe, which also answers News, Sports and email " +
      "sorting questions. " +
      "Each model row has " +
      "a Chat tag that is a toggle (on: users may pick the model for chat; off: the tag dims and " +
      "is struck through), " +
      "and an ACP note when the provider cannot honour a model choice, explaining that chat stays " +
      "on the login's default. The provider catalog offers explicit Codex and OpenCode CLI choices " +
      "because they share a protocol family but use separate agent identities; changing an existing " +
      "OpenAI-compatible provider to CLI auth requires choosing its agent. The Codex ACP row hands " +
      "the instance's shared Codex connection into each user's own isolated runner home, " +
      "and provides a minus button (disable) and a trash button (remove after confirmation; the provider's " +
      "default entry cannot be removed). The Models section collapses from its header. CLI provider " +
      "cards run the ACP adapter's initialize check automatically and show 'Not logged in' when it is refused; " +
      "the Refresh models button only asks for the provider's current model list. A refresh the provider answers " +
      "by refusing the stored sign-in does not serve as the ACP login check. Once a provider has refused a " +
      "sign-in - on a model refresh, or on a chat message it would not answer - is recorded as a " +
      "provider rejection, distinct from a missing or malformed Codex runner credential. Chat checks CLI sign-ins when the " +
      "ACP adapter initializes. Adding an OpenCode CLI provider reveals its ACP card with a saved " +
      "Chat model setting; without an OpenCode provider, that card, its setting, and the OpenCode " +
      "note are hidden even when an old setting is saved. The selected choice is passed to the ACP " +
      "chat launch only when that provider is selected and is applied when the agent advertises that option. " +
      "Codex chat supports the newer models listed after a refresh without requiring a new sign-in or separate installation. " +
      "Live chat reports that API-key providers are not available yet and does not start an engine; " +
      "choose a CLI provider for live chat. A migrated legacy CLI provider without a supported " +
      "ACP agent remains configured but cannot start chat; the response tells the admin to add a " +
      "supported CLI provider. If the active provider changes while a message is being prepared, " +
      "the message is left unsent and the user is asked to retry. " +
      "Codex is connected once for the whole instance: an administrator signs in under Settings, " +
      "Assistant & AI, and every user's chat and background work then use that connection while " +
      "running in their own isolated runner home, as their own account. When Codex refreshes the " +
      "connection for one user, the refreshed connection is shared with everyone. If Codex has never " +
      "been connected, users see 'Codex is not connected yet' rather than a provider failure. If a " +
      "sign-in completes but cannot be saved for everyone, the sign-in reports 'Codex signed in, but " +
      "Moss could not share the sign-in'. " +
      "Pressing Log in on a provider " +
      "always re-checks the sign-in for real rather than reusing an old saved answer, so a " +
      "genuinely broken sign-in always gets a fresh place to sign back in. " +
      "The Services group has an Email reading row: it reads the emails the classifier " +
      "cannot settle and writes their summaries and suggested actions. " +
      "The Services group ends with a Classifier row: a dropdown with Use main model and " +
      "every active JSON-capable model, grouped by provider, plus a Chat gate choice of Off, " +
      "Shadow or On. The Chat gate is an instance-wide setting held through the admin " +
      "configuration boundary; On cannot be chosen until an approved tool release exists, so it " +
      "stays unavailable in the row meanwhile. Once a model is chosen, a line " +
      "under the row says story details, saved story preferences and each email's subject, " +
      "sender, dates and text go to that model first and to the main model if it does not " +
      "answer. For a System One model the line instead says it answers the News, Sports and " +
      "email sorting questions with a yes or no, that each email's subject, sender, dates and " +
      "text go there too, and that the main model still handles other sorting work. When a " +
      "hosted model is chosen and the Chat gate is Shadow or On, the row also says eligible " +
      "chat messages go to its provider, and that when the gate is on every user's eligible " +
      "messages go to that provider. The classifier " +
      "sorts each new email into junk, needs a reply, needs action, receipt or notice, " +
      "waiting on someone, time-sensitive, or for your information; receipts, order and booking " +
      "confirmations and account or policy notices stay kept and searchable but are left out of " +
      "the morning briefing. Mail it is unsure about, or all mail when it fails or none is " +
      "chosen, is sorted by the main model as before. A " +
      "separate Web search group has a 'Use your model's built-in web search' switch, on by " +
      "default, with a status line reading 'On, using Brave', 'On, using each person's chat " +
      "model', or 'Off. Add a Brave key or turn on built-in search.' A Brave Search API key " +
      "field below it is described as giving consistent results for every model, including " +
      "local ones. Shared CLI software is usable by separate Moss accounts; runner startup " +
      "automatically repairs the older installation-directory permission defect using the pinned " +
      "version, so users need no reinstall action. Only administrators can connect CLI providers. " +
      "The line under each CLI provider's name shows the installed tool and its version, for " +
      "example 'Claude CLI 2.1.282'; the OpenCode card shows 'OpenCode CLI' and its version the " +
      "same way. Installing Claude or Codex also installs the small chat helper that connects it " +
      "to Moss chat; if that step fails the install reports an error naming the chat helper, the " +
      "tool itself stays installed, and installing again retries the helper. Until the helper is " +
      "installed, chat uses the copy that shipped with Moss. Moss checks every six hours for a " +
      "newer signed version of Claude and Codex and tests it in a throwaway chat before using " +
      "it. While that runs the card shows 'Updating to X'. If the test fails the card shows " +
      "'Version X held back' (hover for the reason) with a Retry button, and admins get a " +
      "notification. 'Version X needs a newer Moss' means the update waits for a Moss upgrade. " +
      "'Can't check for updates' appears after three days without reaching the update list, " +
      "also with Retry. Retry checks again right away.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "instmods",
    label: "Instance modules",
    description: "Install and enable instance modules.",
    path: "/settings?section=instmods",
    scope: "admin"
  },
  {
    id: "oversight",
    label: "Connector oversight",
    description: "Review connector health across the instance.",
    path: "/settings?section=oversight",
    scope: "admin"
  },
  {
    id: "audit",
    label: "Audit & operations",
    description: "Review instance audit and operational records.",
    path: "/settings?section=audit",
    scope: "admin"
  },
  {
    id: "host",
    label: "Advanced host setup",
    description: "Review non-secret host diagnostics and deployment guidance.",
    path: "/settings?section=host",
    scope: "admin"
  },
  {
    id: "enckeys",
    label: "Encryption keys",
    description:
      "Generate and rotate the encryption keys that lock stored credentials. A banner here and on the settings home names any key that still needs attention; a stored key that no longer opens shows as stopped with a Replace key remediation, while an unusable value in the settings file shows as stopped with guidance to fix or remove it there and no button. Keys are never shown.",
    path: "/settings?section=enckeys",
    scope: "admin"
  }
];

export const CORE_APP_ERRORS: readonly CoreAppErrorDeclaration[] = [
  {
    code: "core.ai.action_not_approved",
    class: "permission",
    remediationRef: "core.ai.ask_user",
    description: "An agent action was not approved, so it was not done."
  },
  {
    code: "core.ai.cli_version_too_old",
    class: "prerequisite",
    remediationRef: "core.ai.check_cli_version",
    description:
      "The installed AI tool is too old for this model. Moss looks for a newer version " +
      "automatically; an admin can press Retry in Settings > AI providers."
  },
  {
    code: "core.ai.cli_update_held_back",
    class: "prerequisite",
    remediationRef: "core.ai.retry_cli_update",
    description:
      "A newer Claude or Codex version failed Moss's test chat, so Moss kept the current one. " +
      "Nothing is broken."
  },
  {
    code: "core.ai.cli_update_needs_newer_moss",
    class: "prerequisite",
    remediationRef: "core.ai.retry_cli_update",
    description:
      "A newer Claude or Codex version needs a newer Moss than the one installed, so it waits."
  },
  {
    code: "core.ai.cli_update_cannot_check",
    class: "prerequisite",
    remediationRef: "core.ai.retry_cli_update",
    description:
      "Moss has not reached the list of Claude and Codex updates for three days. The current " +
      "versions keep working."
  },
  {
    code: "core.ai.api_key_live_chat_unavailable",
    class: "prerequisite",
    remediationRef: "core.ai.connect_cli_provider",
    description:
      "Live chat cannot start with an API-key provider; it requires a supported CLI provider."
  },
  {
    code: "core.ai.unsupported_legacy_cli_provider",
    class: "prerequisite",
    remediationRef: "core.ai.add_supported_cli_provider",
    description: "This legacy CLI provider has no supported ACP agent for live chat."
  },
  {
    code: "core.ai.chat_provider_changed",
    class: "transient",
    remediationRef: "core.ai.retry_chat_message",
    description: "The active provider changed before the chat message was sent."
  },
  {
    code: "core.today.day_plan_review_unavailable",
    class: "prerequisite",
    remediationRef: "core.today.review_when_plan_available",
    description:
      "Task block review is unavailable while today's saved plan is missing, loading, or unreadable."
  },
  {
    code: "core.today.briefing_retry_unconfirmed",
    class: "transient",
    remediationRef: "core.today.retry_briefing",
    description: "The briefing reader could not confirm whether a retry request was queued."
  },
  {
    code: "core.today.evening_loop_save_failed",
    class: "transient",
    remediationRef: "core.today.retry_evening_loop",
    description:
      "An evening open-loop choice (Tomorrow, Choose a day or Let it go) could not be saved, so the task was not changed."
  }
];

export const CORE_APP_REMEDIATIONS: readonly CoreAppRemediationDeclaration[] = [
  {
    id: "core.ai.ask_user",
    description: "Ask the user to approve the action before trying it again.",
    path: "/",
    scope: "user"
  },
  {
    id: "core.ai.check_cli_version",
    description:
      "Open Settings > AI providers and press Retry beside the provider's update notice. If no " +
      "newer version is available, choose a model the installed tool supports.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "core.ai.retry_cli_update",
    description:
      "Open Settings > AI providers and press Retry beside the provider's update notice. If it " +
      "is held back again, it stays on the current version until a later release passes.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "core.ai.connect_cli_provider",
    description:
      "Ask an administrator to choose a supported CLI provider for live chat. API-key chat is not available yet.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "core.ai.add_supported_cli_provider",
    description:
      "Ask an administrator to add an Anthropic, Codex, OpenCode, or Google CLI provider for live chat.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "core.ai.retry_chat_message",
    description: "Retry the message after the provider change.",
    path: "/chat",
    scope: "user"
  },
  {
    id: "core.today.review_when_plan_available",
    description:
      "Keep reading the briefing; try Review task blocks again after the saved plan loads.",
    path: "/today",
    scope: "user"
  },
  {
    id: "core.today.retry_briefing",
    description:
      "Try again from the briefing reader. Existing task-block choices remain available.",
    path: "/today",
    scope: "user"
  },
  {
    id: "core.today.retry_evening_loop",
    description: "Press the same choice again on the task; its three choices stay available.",
    path: "/today",
    scope: "user"
  }
];
