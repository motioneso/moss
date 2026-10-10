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
      "Read the saved day plan as a schedule and preparation list with each block's state in words (committed versus proposed), plus a prominent weather row, a quick-actions dock with slot-placed module widgets, task and event details, email action rows, and goals. Needs You shows active action rows and visible Loose ends together in a labelled group, with both included in its count; Catch-up sits outside that count and lists up to eight emails since the last morning briefing (since the start of the day in the evening) that are worth knowing about but need no action: mail the email sorter marked for information or waiting on someone else, not low importance, and not mailing-list mail unless it is high importance. Each row shows the sender, an Important or Waiting on them badge when it applies, a one-line summary and the time it arrived; five rows show and the rest sit behind Show N more. Each row offers Open (only when the email provider gave a link), Reply (opens chat to draft a reply; enabled for every user whenever chat is usable, and disabled otherwise), Add task (adds a Follow up with <sender> task) and Dismiss; after Add task or Dismiss the row says Added to your tasks or Dismissed with Undo, and a handled email stays off later briefings. If saving fails the row returns and says That did not save. Try again. A Why these emails? tip explains the rule, a closing line counts the newsletters, receipts and notifications left out, and the block is absent when no email qualifies. View appears only when an action row already has a supported source link. Today previews the briefing lead; the full reader shows the source-grounded report as a headline line, a two-to-three sentence lead, and sections headed by what to do that walk through the day's events in time order with their times and places, what to prepare or bring, and today's forecast, plus priorities, verified changes and follow-up where available, plus a What informed this briefing block naming each source in plain words (such as Today's schedule, Weather, Tonight and tomorrow, Today's email, This morning's plan and Task review) with its time and a short line on what it contributed, such as a count of events, emails read or tasks reviewed, with no line when a source was empty or failed and plain source names in the No longer available notes below the list, and earlier reports, naming overnight changes to the saved evening plan. If a morning run fails, the reader can retry it, shows the new run as pending, and displays its result when ready. When no evening priorities are available, it explains that today's available sources, including tasks and calendar, shaped the report; a delayed email source names its last update and possible unseen replies. When the email source is over a day old, Today shows a Refresh email action beside Read the full morning briefing, outside the reader; it starts one updated briefing only after email refresh succeeds or partially succeeds and retains the current report and plan choices if refresh or briefing preparation fails. A Review task blocks button opens per-block placement and time choices with preview, one confirmation for moves and removals, and per-item outcomes. An Accept all time blocks button in the reader and the review applies every eligible proposed addition in one activation. A Plan tomorrow button opens an evening planning dialog with reflect, commitment, shape and review sections that saves tomorrow's intent and draft blocks in one action. The reflect section shows the latest evening report formatted like the reader, with its section headings, paragraphs and lists, above the reply choices. Light considers one priority block, a steady day considers the main task plus one follow-through block, and Full day considers all selected commitments while using open time. Unsaved placement choices immediately appear under Proposed calendar changes before the plan is saved. In the Plan tomorrow side column, a Room to get home and have lunch note appears only when at least an hour is free between the last calendar entry and the first proposed block, an N minutes between task blocks note appears only when every gap between proposed blocks is the same, and Moss task blocks already on tomorrow's calendar sit in an Existing calendar task blocks fold instead of the main list unless automatic scheduling is on. A Chat with Moss button on the same card opens the evening interview carrying the saved plan, and can save intent and untimed additions for review without ever writing to the calendar. When the calendar or the saved plan cannot be read the schedule says so plainly instead of showing an empty day, and loaded events stay visible while the plan is still arriving. On Today's schedule, a Moss-planned block already on the calendar carries a Flexible tag, a block Moss is suggesting for the first time says Proposed, and a preparation block that ends right when a calendar event starts adds a line naming that event and its time (no line appears when no event backs one). The schedule also shows the gaps between blocks and commitments as a break or as open time, and a closing line once the day's commitments are done; all of it comes only from the times already on the schedule. A First meeting card names the day's first meeting, its length and place, and adds a preparation line only when a real calendar block immediately before it is itself titled as preparation; a See meeting button opens that exact meeting on the calendar screen. Below it, a Since last night section appears only when a block in today's plan moved since the morning report was prepared, naming the block and its old and new time. Under it, a practical note (A little practical context) names the next later event today that has a place, with its title, start time and place, and never guesses a leave time or travel time; it appears only when a timed calendar event later today has a place, and is absent otherwise. The side column has no preparation list because no source links materials to a meeting, and it no longer repeats the day's counts or agenda. After the evening briefing time, the Today page drops the schedule section and the header shows the evening report's opening verdict with Read the full evening briefing, which opens the latest evening report in the full reader labelled Evening briefing, and What informed this?, which opens the same reader with its source list expanded; the evening reader has no task-block review or footer actions, and a failed evening run can be retried from it. What happened today opens with the report's What got done prose, and Close the open loops opens with its Carrying forward prose, then lists each open task with a reason line taken from its due date (no reason line when it has no due date) and three choices, Tomorrow, Choose a day and Let it go, which move its due date or archive it, and shows \"Nothing needs a decision tonight.\" when nothing is carrying forward; if saving a choice fails, the task keeps its three choices and shows \"Could not save that. Try again.\", and pressing a choice again retries; each part appears once, and a slot whose section is missing stays empty. Under What happened today, each finished task shows its own description as a note, or the time it was completed when it has no description, and no note when it has neither. The header and the reader both show when the report was prepared as a 12-hour time with am or pm for English regions (for example Prepared at 8:00 am), taken from the saved run time and shown in the person's own time zone; other regions see their own localized time. The header shows faint topographic contour lines behind its text, fading out toward the left. The header label reads Morning briefing before noon and Today's briefing after. When no report is readable yet, the header says why beside Briefing not ready yet: the morning briefing is switched off, today's run failed or was blocked, it runs at the set time, or it should have run at that time. On a quiet day, when the briefing, the now-list and the evening review all have nothing to show, Today replaces their separate empty messages with one quiet line (the briefing's reason still shows in the header); as soon as any one of them has content, they all show as separate sections again. On a phone, the section links under the header, the add-medication plus button and the story links under each followed sports team each have a tap area at least 44 pixels tall, spaced at least 8 pixels from the next link. No text on Today is smaller than 11 pixels. The page header shows the title and the date under it (for example SUN · OCT 4) and has no settings cog, because this page has no settings of its own.",
    path: "/today",
    scope: "user"
  },
  {
    id: "notifications",
    label: "Notifications",
    description:
      "Review notifications produced by enabled modules. The account menu button at the bottom of the rail shows the person's name and avatar only (no email line, unless no name is set) and the unread count as a badge when the menu is closed, and screen readers hear the number as part of the button's spoken label. The page header shows the title and the date under it (for example SUN · OCT 4) and has no settings cog, because this page has no settings of its own. How much Moss pushes to the phone is set in Settings under Notifications, as one saved choice per person: Quiet pushes only urgent items, Balanced (the default) pushes urgent and normal items but not low ones, and Proactive pushes everything. The same choice decides whether the summary sent when quiet hours end is sent for a deferred item. The list here and the daily briefing always show every notification whatever the level.",
    path: "/notifications",
    scope: "user"
  },
  {
    id: "settings",
    label: "Settings",
    description:
      "Personal and admin settings. A search box on the top bar matches section names, descriptions and common setting words, and also matches every installed module that has its own settings to open (for example News) by that module's name, description, and the name of each individual setting or credential it declares (for example, searching a credential's own name like \"Plaid\" finds the module that uses it). A module with nothing to configure is left out of the results. Picking a result jumps straight to that module's settings. On a phone, opening Settings with nothing chosen shows the full list of sections; choosing one folds the list into a bar that names the current section, and tapping that bar brings the list back as a sheet from the bottom, which closes with Escape or the close button. On a phone the AI provider actions (log in, terminal or test, edit, remove) sit in a More menu on each provider; on a wide screen they stay visible as buttons. While Moss is still loading, including when a section is opened directly by its address on a slow connection, the page shows a centred, gently animated Moss logo mark with the words Loading Moss instead of an empty page, and the section replaces it once it is ready. The page header shows the title and the date under it (for example SUN · OCT 4) and has no settings cog, because this page has no settings of its own.",
    path: "/settings",
    scope: "user"
  },
  {
    id: "link-trail-marker",
    label: "Link a Mac",
    description:
      "Approve or decline a Mac asking to connect to this account. The Mac opens this screen with a request code in the address; the page names the Mac that is waiting and lists what a linked Mac will be able to do (check in and rename itself, read which focus block is on now, report which app is in front while one is on, and receive a nudge decision; on supported Macs, Record meetings when you choose Start) and says it never receives the account password or browser session. Approving links it and it then appears under Active sessions in Account & preferences, where it can be signed out. A request expires after ten minutes, and an expired, already-answered or unknown request says so and asks the person to start again from the Mac.",
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
      "Edit personal profile and account details, time zone, date format, weather unit (Fahrenheit unless changed) and weather location (use the browser's location or search for a place; the hint under the location notes which of those two was used this session), quiet hours, sessions, data export and account deletion. A Trail Marker for Mac group explains the menu-bar Mac companion, says the app is not available to download yet, points to Trail Marker's Connect in Browser flow, describes how browser approval links a Mac and what the linked Mac may do, and points at Active sessions as the place a linked Mac appears and can be signed out. The single initial linking approval also authorizes recording on supported Macs, with Record meetings when you choose Start in its capabilities list. There is no separate recording approval card. Macs missing or with revoked recording authority must use Unlink Mac in Settings → Meetings and explicitly relink through Trail Marker; already-approved Macs remain linked. Connection alone never starts recording. Settings → Meetings shows Mac link status, the Audio source dropdown, Summarize automatically after Stop (on by default) and Unlink Mac. Turn the summary switch off to generate summaries only through Rewrite summary. New meetings default to microphone plus system audio; existing exact source choices stay in effect until changed. Meetings and Backtrack share the companion connection while Backtrack retains its own consent settings. During a meeting, the Meetings navigation dot and top-bar duration link back to the recording while you browse other modules. Pause and Stop stay on the meeting page; connection uncertainty and delayed transcription remain separate. Active sessions lists a linked Mac by the name it gave, with its app version. About the Mac app itself (not shown on this page): Trail Marker only takes a picture of the exact window in front, and only when Accessibility is granted so it can identify that window (if it can't, it takes none; remedy: grant Trail Marker Accessibility in the Mac's System Settings); its menu's Pause All pauses everything and sends nothing at all (its Test vision button then says to resume first), and a Focus switch in the menu pauses just Focus while staying connected (Test vision then says to switch Focus back on); logging out, or Moss revoking the Mac, clears its Focus settings on that Mac." +
      " Backtrack is currently a Debug-build-only preview in the Mac app's Settings, with separate consent and a menu switch. It reads the front window's visible text through Accessibility, skipping password fields, and uses on-device text recognition only when that gives too little. It keeps text in memory on that Mac until quit, with Show text and search; it does not yet upload anything. Moss can store Backtrack history only when an admin turns Backtrack storage on; Settings > Modules > Backtrack then shows and deletes it, kept 37 days, plus up to one hourly run. Chat cannot answer from it yet. Switches and periodic checks skip recently read similar screens, with a fresh read after at most five minutes; a window that keeps showing nothing new is read less often, and periodic reads wait while you type. After five minutes without keyboard or mouse input it stops recording; use the keyboard or mouse to resume within five seconds. Pause All, lock, sleep, missing permissions and Never watch exclusions also stop capture; resume, unlock or grant Accessibility and Screen Recording in Mac System Settings as appropriate. Turning Backtrack off, withdrawing consent, logging out or revoking the Mac clears remembered text.",
    path: "/settings?section=profile",
    scope: "user"
  },
  {
    id: "appearance",
    label: "Appearance",
    description:
      "Choose the app theme and color mode, or build your own theme. Each theme card shows a small Moss screen in that theme's colors, nav included; Apply switches to it, and custom themes can be edited, duplicated or deleted. The color mode switch applies to built-in themes; custom themes always keep their saved colors. Loading screens follow the chosen color mode from the very first moment, and the browser address bar matches the page color; on a browser where no choice has been saved yet they follow the device light or dark setting. In the custom theme editor, each color (page, cards, text, lines, accent and highlight) has a solid color box and a hex field. Paste a palette from a palette tool and its colors show as swatches; pasting changes nothing until you pick. Every color box opens a picker with a From your palette row on top and Any color below. Highlight colors the rules and markers under the Today band, never text. A Page header group sets the color of the strip across the top of every page (page title, date line and settings cog) on a computer only; on a phone (920px wide or less) that strip follows the Nav bar color instead, and without a header color the strip stays the theme's page color. A Nav bar group sets the color of the left nav column, and on a phone the top bar and the menu; text and icons pick dark or light by themselves so labels stay readable, and Reset to default returns to the theme's pale nav. The small Today preview updates as you type, and clicking a part of it (page, text, accent band or button, highlight rule, nav bar, page header, card) opens the picker for the color that paints it. A Can people read it? list rates each text and color pairing. Nothing applies until Save. Without a nav color, the top bar wears the theme's own page color and its title, date and trail labels take readable text from the theme's text color, so a theme made from dark mode keeps a dark, readable bar.",
    path: "/settings?section=appearance",
    scope: "user"
  },
  {
    id: "assistant",
    label: "Your assistant",
    description:
      "Change the AI model for chat: choose which model answers, change model routing and response behavior. The chat panel header and message box follow whether a chat model is available: with none, the header reads Not connected and a Connect a provider link to this screen replaces the message box, and with an admin-locked model that is unavailable, the header reads Model unavailable and the message box is disabled. When Auto-approve actions is on for your account, agent tool requests eligible for approval run without a confirmation card and are recorded as auto-approved in Activity. Unknown, unavailable, malformed, and forbidden-path requests remain refused. Turning Auto-approve actions off restores confirmation for the next eligible request. Also choose assistant behavior and response style (concise, balanced, or detailed, each shown with an example answer of that length) available to this user. Write the persona as free text or set it with guided dials. The preview area invites the user to press Preview until a real reply comes back, and shows the invitation again after the persona text, dials, or assistant name change. Preview a response with the selected chat provider; a CLI preview requires a supported ACP agent and a working sign-in and runner connection, which an admin can check in Admin > AI providers. Selecting a Codex model clears a saved OpenCode chat choice. The model button above the chat message box shows the selected model's readable name, falling back to the provider's model identifier and then to Instance default when no readable name is known. When a default chat model is set, a note explains that an admin must add a transcription model (in Admin > AI providers) to turn on the microphone in chat. The chat panel works with the keyboard: opening it moves focus into the message box (or onto the panel when the message box is replaced or disabled), Escape closes it and returns focus to the button that opened it, and on a phone Tab and Shift+Tab stay inside the open panel and screen readers treat it as a modal dialog, including beside a running draft. On a window 1280 pixels wide or more the chat panel sits beside the page and narrows it, so you can see the page while you chat. On narrower windows it floats over the right side of the page, except beside a running draft module, where it stays beside the page down to the phone width. Beside the page the chat panel is square-cornered and flush with the window edge, separated from the page by a single divider line, and its message box shows one outline. On a phone it is an overlay drawer that keeps its rounded floating shape. The chat panel header has four buttons: New chat, Expand, More, and Close. History and Start private chat (the private chat toggle) are in the More menu, which opens from the three-dot button. On a desktop window with the chat docked beside the page, Expand makes the chat fill the whole main area, replacing the page header and page body while the left navigation stays, and Collapse in the same spot returns to the docked panel. Expanded chat reads in a centred column. Choosing another screen from the left navigation opens that screen and returns the chat to docked, keeping any unsent text, and closing the chat or reloading the app also returns it to docked. There is no Expand button on a phone. " +
      "Approval cards for app actions show the server-owned action title, full resolved target and exact requested changes as readable label and value rows, with Approve and Reject controls. Approve uses the normal primary style; deleting a saved memory or a note uses red. Note deletion states that it is permanent with no trash or undo. Approval buttons have a clear keyboard focus outline. File and shell permission cards use the same layout while retaining the exact path or command needed for the decision. Connected tools without an authored readable presentation show their complete validated arguments without truncation. Cards that follow outside content show one short notice. When details are missing or cannot be fully disclosed, Approve is unavailable and Reject remains available; ask for a fresh request or use the app screen. Restored requests regain their normal card only when complete server details are available. Decided cards become one quiet result line without a selected-box outline; keyboard focus and announcements remain available. Successful chat actions refresh affected cached screens without a page reload. The assistant name set here replaces the word Moss in screen text across the app: the loading screen, the top bar, the browser tab title, settings, onboarding, Today and notifications. Text quoted in this map shows the default name Moss; a user who renamed their assistant sees that name instead. Before the name loads, screens show the last name saved in the browser, or Moss if none.",
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
      "Review every model call Moss made for you: chat answers, structured tasks, " +
      "transcription, embeddings, background tasks and tool runs, each as a plain action " +
      "with how long it took. Opening a line shows the detail dialog with its steps and " +
      "facts. Filter by time range, module, or model with the model checklist; choices " +
      "are remembered per user and Reset filters restores the default. Quoted words " +
      "expire after 30 days while the line itself stays. Admins also see System lines " +
      "for ownerless calls.",
    path: "/settings?section=activity",
    scope: "user"
  },
  {
    id: "released",
    label: "What's new",
    description: "See what was added, fixed, and changed in recent Moss releases.",
    path: "/settings?section=released",
    scope: "user"
  },
  {
    id: "connections",
    label: "Connections",
    description:
      "One pane for everything the assistant can reach outside itself, with three parts: Accounts, Notes folder, and Apps & services. " +
      "Accounts: connect external accounts and review their status. Add an email account by typing its address; Yahoo Mail, Proton Mail, iCloud and Fastmail addresses are recognised and get their mail server settings and app-password instructions filled in, other addresses choose the mail service by hand. " +
      "Notes folder: review sources the assistant can read and choose the notes folder. Every folder comes " +
      "from the same list of folders available on the server, and People notes live inside " +
      "the chosen notes folder. An info icon explains how folders get listed. " +
      "Apps & services: connect external tools and services. Opening a connection fills the whole settings " +
      "area: the settings menu hides, a Back to connections link returns to the list, and the " +
      "connection's name and address head the page. A Connection panel beside the tools (above " +
      "them on a phone) has a Use switch for the whole connection, its status (Connected, Off, or " +
      "Can't reach it with the error), how it connects, its address, how many tools were found " +
      "and when it was last checked, a Check for new tools button (Check again after an error; " +
      "hidden for a pasted spec) and Remove. Under them a sorting line says Moss is sorting the " +
      "tools while it does and what is sent, then Sorted by what they do on a date, naming the " +
      "model or models that read each tool's name, description and inputs, saying how many " +
      "tools Moss sorted itself without sending them, or giving only the date when how they " +
      "were sorted is not recorded; tools whose sort failed get a Try again, except that a sort " +
      "that failed only because no model was set up runs again by itself once one is chosen. " +
      "Below the " +
      "Connection panel a Classifier panel has a Let the classifier use this connection switch " +
      "and shows one of eight states: Off; a one-time confirmation before anything is sent, " +
      "listing what is sent, who reads it, what it costs and what is not sent, with Turn on and " +
      "prepare and Cancel; Preparing, with how many tools are done and a progress bar; Ready, " +
      "with how many tools can answer quick requests (look-up tools are left out, since the " +
      "classifier never offers them), how many always ask before they run, that " +
      "YOLO mode skips the asking, and when they were prepared; a tool changed, which says how " +
      "many are being prepared again; Couldn't prepare, saying why (for example the default chat " +
      "model did not answer) with Try again, which also sorts again any tool whose sort " +
      "failed, plus Change default model, which opens Your assistant, when no model is set " +
      "up or the model did not answer properly. Once a model is chosen, tools that failed only " +
      "for want of one are sorted and prepared by themselves, without Try again, when the " +
      "connection is opened again or the model settings change while it is open; a call cut " +
      "off part way still waits for Try again. The other states are No tools left, when every tool is off, kept " +
      "out, failed to sort or cannot be prepared, so quick requests go through the default " +
      "model; and Paused, when the app can't be reached, which picks up again by itself. " +
      "While it is on, a What is sent, and what it costs link shows the same notice. The notice " +
      "says Moss does not add the connection's saved address or sign-in settings to the request " +
      "and runs no tool for the step, and that text the service provides is sent as written and " +
      "is not checked for secrets. The Tools section heading counts how many tools are on and " +
      "says that tools marked Asks first check with the owner before they run and that YOLO mode " +
      "skips the asking. Every tool starts on, except on an " +
      "app with a lot of tools, where they start off. Tools are grouped by what they do: Looks " +
      "things up, Changes things, Sends things out, Sensitive, and Not sorted yet; before Moss " +
      "has sorted them they show A to Z with a note saying so, and the open page fills in the " +
      "groups by itself once sorting finishes. The owner can switch between " +
      "By what it does and A to Z. A search box, which matches a tool's readable name, its raw " +
      "name or its description, and an All, On or Off filter narrow the list; a " +
      "long group shows six tools and a Show more link. Each tool shows a readable name in bold " +
      "with the service's raw tool name small underneath, its own on or off switch, " +
      "and each group has Turn all off (Turn all on when every tool in it is off). Tools that " +
      "ask first carry an Asks first mark, and a tool being prepared again after a change " +
      "carries a Preparing again mark. Each tool has a menu with Keep out of the classifier " +
      "(chat can still use it), which shows an Undo and marks the tool as kept out, and Let " +
      "the classifier use it to reverse it. On a sending tool, the menu also offers Send " +
      "without asking, after which it carries a Sends without asking mark, or Ask before " +
      "sending to undo it. The Sends things out group has Send all without asking, which asks " +
      "for confirmation first, and Ask first for all once any tool is allowed. When the gate " +
      "is active, a tool that needs a device or area name can pick it from the connection's own " +
      "list, read through a prepared tool sorted as Looks things up; the list is cached briefly " +
      "for that owner only, and a missing or expired list keeps the " +
      "tool out. Old links to Connected accounts, Data sources and Integrations open this pane.",
    path: "/settings?section=connections",
    scope: "user"
  },
  {
    id: "modules",
    label: "Modules",
    description:
      "Enable or disable user-toggleable modules. Every page header shows the page title with the date under it (for example SUN · OCT 4), including a Workshop project and the new-project page. Tasks, Calendar, Wellness, News and Sports also show a settings cog beside the title, which opens that module's own settings here. Today, The Workshop, Notifications and Settings have no cog because they have no settings of their own. A module that declares its own settings page sends its cog to that page, and this Modules list shows it as a link to the page instead of its own switches.",
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
    label: "AI providers",
    description:
      "Configure instance AI providers, models, and bindings. Each provider card lists its models " +
      "with a Refresh models button (asks the provider for its current list; the line under the " +
      "list then reads 'Refreshed: N models', 'Not logged in', 'This provider cannot list its " +
      "models yet', 'The sign-in helper is not running', 'The provider rejected the API key', or 'Could not reach the provider') and an " +
      "Add model button (type in a model by hand; such rows show a * after the id, the footer " +
      "reads '* Manually added', and they survive refreshes and re-logins). A decision model (the " +
      "System One provider kind) is offered as three presets: Jev (TypeSafe), Clef (Cloudflare) and " +
      "Any compatible service. Jev asks for an optional address and an API key; Clef asks for a " +
      "Cloudflare account ID and API token and builds the address from them; Any compatible " +
      "service asks for an address and an API key, stays addable more than once, and is named for " +
      "its address host (for example Decision model (openrouter.ai)). A decision " +
      "model answers fixed named questions and is used only for the Trail Marker focus judgment " +
      "and the story and email sorting questions, not chat: its models are offered only in the " +
      "Classifier row and its card has no Set as default button. A model added by hand on a " +
      "decision model starts with the JSON capability and the Economy tier. When a decision-model " +
      "service has no model list, its Test line says the service does not list its models, so the " +
      "key could not be checked, and points to adding one by hand. The " +
      "Classifier row also sets the model " +
      "that judges Trail Marker focus; nothing is judged until an admin chooses one there. Once " +
      "one is chosen it says Trail Marker's app and window titles also go to that model, or for " +
      "a decision model that they go to the chosen service (TypeSafe for Jev), which also answers " +
      "News, Sports and email " +
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
      "General live chat reports that API-key providers are not available yet and does not start an engine; " +
      "choose a CLI provider for general live chat. The normal docked drawer automatically attaches the open meeting as removable context, using its saved notes even before a transcript exists. Answers link transcript timestamps back to the exact line. These selected-meeting questions require the selected API-key chat model and run without tools; subscription meeting chat is not supported yet. Remove the About this meeting chip to continue ordinary chat with a subscription model. The chip announces the attached meeting title to screen readers. Failed meeting questions remain visible above their error in the open chat. A migrated legacy CLI provider without a supported " +
      "ACP agent remains configured but cannot start chat; the response tells the admin to add a " +
      "supported CLI provider. If the active provider changes while a message is being prepared, " +
      "the message is left unsent and the user is asked to retry. " +
      "Codex is connected once for the whole instance: an administrator signs in under Settings, " +
      "AI providers, and every user's chat and background work then use that connection while " +
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
      "configuration boundary. On needs a shadow review recorded for the current classifier, " +
      "and changing the classifier drops On back to Shadow until the new one is reviewed. No " +
      "review can be recorded yet, so On stays unavailable in the row meanwhile and every " +
      "message still goes to the main model. Once a model is chosen, a line " +
      "under the row says story details, saved story preferences and each email's subject, " +
      "sender, dates and text go to that model first and to the main model if it does not " +
      "answer. For a decision model the line instead says it answers the News, Sports and " +
      "email sorting questions with a yes or no, that each email's subject, sender, dates and " +
      "text go there too, and that the main model still handles other sorting work. When a " +
      "hosted model is chosen and the Chat gate is Shadow or On, the row also says eligible " +
      "chat messages go to its provider, and that when the gate is on every user's eligible " +
      "messages go to that provider. While the Chat gate is in Shadow, each eligible, non-private " +
      "message is also classified so the record shows whether the gate would have handled it; no " +
      "tool runs, no approval card appears and the main model still answers, and private chats and " +
      "oversized messages are never sent to the classifier. The classifier " +
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
    id: "shadowreport",
    label: "Shadow report",
    description:
      "Temporary report comparing the classifier's shadow guesses with what the main model " +
      "did, reached from the Classifier row while the gate is in Shadow. Counts over 7, 30 " +
      "or 90 days: messages checked, times it picked a tool, times the main model agreed " +
      "(x of y), and times it missed a tool the chat used, plus the disagreement rows. " +
      "A chat tool the classifier cannot use is left unnamed and is not counted as missed. " +
      "Shows only the viewing admin's own records.",
    path: "/settings?section=shadowreport",
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
    description:
      'An action that was not approved is not done. Chat distinguishes "You declined", "Timed out" and "Cancelled"; guidance for Moss is separate from the visible message.'
  },
  {
    code: "core.ai.tool_added_after_chat_started",
    class: "prerequisite",
    remediationRef: "core.ai.start_new_chat",
    description:
      "A chat keeps the tools it had when it started. A tool from an integration connected " +
      "or switched on later is refused in that chat, or not offered at all."
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
    code: "core.ai.chat_no_model_available",
    class: "prerequisite",
    remediationRef: "core.ai.connect_chat_provider",
    description:
      "No chat model is available. The chat panel header reads Not connected, the message box is replaced by a Connect a provider link to Settings > Your assistant, and nothing can be sent."
  },
  {
    code: "core.ai.chat_locked_model_unavailable",
    class: "prerequisite",
    remediationRef: "core.ai.restore_locked_chat_model",
    description:
      "The chat model an admin locked is unavailable. The chat panel header reads Model unavailable, the message box is disabled, and a warning explains how to restore it."
  },
  {
    code: "core.ai.api_key_live_chat_unavailable",
    class: "prerequisite",
    remediationRef: "core.ai.connect_cli_provider",
    description:
      "General live chat cannot start with an API-key provider; it requires a supported CLI provider. Selected-meeting questions are the separate API-key-only capability in the same drawer."
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
    id: "core.ai.start_new_chat",
    description: "Start a new chat. A new chat picks up every tool connected and switched on now.",
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
    id: "core.ai.connect_chat_provider",
    description:
      "Press Connect a provider in the chat panel, or open Settings > Your assistant, and connect a provider that can chat.",
    path: "/settings?section=assistant",
    scope: "user"
  },
  {
    id: "core.ai.restore_locked_chat_model",
    description:
      "Ask an administrator to re-enable the locked chat model or clear the lock in Settings > AI providers.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "core.ai.connect_cli_provider",
    description:
      "Ask an administrator to choose a supported CLI provider for general live chat. API-key models currently support selected-meeting questions only.",
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
