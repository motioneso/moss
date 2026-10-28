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
      "Read the saved day plan as a schedule and preparation list with each block's state in words (committed versus proposed), plus a prominent weather row, a quick-actions dock with slot-placed module widgets, task and event details, email action rows, and goals. Needs You shows active action rows and visible Loose ends together in a labelled group, with both included in its count; no-action confirmation emails are left off Today. Catch-up sits outside that count and lists up to eight emails since the last morning briefing (since the start of the day in the evening) that are worth knowing about but need no action: mail the email sorter marked for information or waiting on someone else, not low importance, and not mailing-list mail unless it is high importance. Each row shows the sender, an Important or Waiting on them badge when it applies, a one-line summary and the time it arrived; five rows show and the rest sit behind Show N more. Each row offers Open (only when the email provider gave a link), Reply (opens chat to draft a reply; enabled for every user whenever chat is usable, and disabled otherwise), Add task (adds a Follow up with <sender> task) and Dismiss; after Add task or Dismiss the row says Added to your tasks or Dismissed with Undo, and a handled email stays off later briefings. If saving fails the row returns and says That did not save. Try again. A Why these emails? tip explains the rule, a closing line counts the newsletters, receipts and notifications left out, and the block is absent when no email qualifies. View appears only when an action row already has a supported source link. Today previews the briefing lead; the full reader shows the source-grounded report as a headline line, a two-to-three sentence lead, and sections headed by what to do that walk through the day's events in time order with their times and places, what to prepare or bring, and today's forecast, plus priorities, verified changes and follow-up where available, plus a What informed this briefing block naming each source in plain words (such as Today's schedule, Weather, Tonight and tomorrow, Today's email, This morning's plan and Task review) with its time and a short line on what it contributed, such as a count of events, emails read or tasks reviewed, with no line when a source was empty or failed and plain source names in the No longer available notes below the list, and earlier reports, naming overnight changes to the saved evening plan. If a morning run fails, the reader can retry it, shows the new run as pending, and displays its result when ready. When no evening priorities are available, it explains that today's available sources, including tasks and calendar, shaped the report; a delayed email source names its last update and possible unseen replies. When the email source is over a day old, Today shows a Refresh email action beside Read the full morning briefing, outside the reader; it starts one updated briefing only after email refresh succeeds or partially succeeds and retains the current report and plan choices if refresh or briefing preparation fails. A Review task blocks button opens per-block placement and time choices with preview, one confirmation for moves and removals, and per-item outcomes. An Accept all time blocks button in the reader and the review applies every eligible proposed addition in one activation. A Plan tomorrow button opens an evening planning dialog with reflect, commitment, shape and review sections that saves tomorrow's intent and draft blocks in one action. The reflect section shows the latest evening report formatted like the reader, with its section headings, paragraphs and lists, above the reply choices. Light considers one priority block, a steady day considers the main task plus one follow-through block, and Full day considers all selected commitments while using open time. Unsaved placement choices immediately appear under Proposed calendar changes before the plan is saved. In the Plan tomorrow side column, a Room to get home and have lunch note appears only when at least an hour is free between the last calendar entry and the first proposed block, an N minutes between task blocks note appears only when every gap between proposed blocks is the same, and Moss task blocks already on tomorrow's calendar sit in an Existing calendar task blocks fold instead of the main list unless automatic scheduling is on. A Chat with Moss button on the same card opens the evening interview carrying the saved plan, and can save intent and untimed additions for review without ever writing to the calendar. When the calendar or the saved plan cannot be read the schedule says so plainly instead of showing an empty day, and loaded events stay visible while the plan is still arriving. On Today's schedule, a Moss-planned block already on the calendar carries a Flexible tag, a block Moss is suggesting for the first time says Proposed, and a preparation block that ends right when a calendar event starts adds a line naming that event and its time (no line appears when no event backs one). The schedule also shows the gaps between blocks and commitments as a break or as open time, and a closing line once the day's commitments are done; all of it comes only from the times already on the schedule. A First meeting card names the day's first meeting, its length and place, and adds a preparation line only when a real calendar block immediately before it is itself titled as preparation; a See meeting button opens that exact meeting on the calendar screen. Below it, a Since last night section appears only when a block in today's plan moved since the morning report was prepared, naming the block and its old and new time. Under it, a practical note (A little practical context) names the next later event today that has a place, with its title, start time and place, and never guesses a leave time or travel time; it appears only when a timed calendar event later today has a place, and is absent otherwise. The side column has no preparation list because no source links materials to a meeting, and it no longer repeats the day's counts or agenda. After the evening briefing time, the Today page drops the schedule section and the header shows the evening report's opening verdict with Read the full evening briefing, which opens the latest evening report in the full reader labelled Evening briefing, and What informed this?, which opens the same reader with its source list expanded; the evening reader has no task-block review or footer actions, and a failed evening run can be retried from it. What happened today opens with the report's What got done prose, and Close the open loops opens with its Carrying forward prose, then lists each open task with a reason line taken from its due date (no reason line when it has no due date) and three choices, Tomorrow, Choose a day and Let it go, which move its due date or archive it, and shows \"Nothing needs a decision tonight.\" when nothing is carrying forward; if saving a choice fails, the task keeps its three choices and shows \"Could not save that. Try again.\", and pressing a choice again retries; each part appears once, and a slot whose section is missing stays empty. Under What happened today, each finished task shows its own description as a note, or the time it was completed when it has no description, and no note when it has neither. The header and the reader both show when the report was prepared, taken from the saved run time and shown in the person's own time zone and 12/24-hour choice (for example Prepared at 8:00 am, or Prepared at 08:00 on 24-hour time); other regions on 12-hour time see their own localized time. Every other time on Today, in its review dialogs and in the chat starters follows the same time zone and 12/24-hour choice. The header shows faint topographic contour lines behind its text, fading out toward the left. The header label reads Morning briefing before noon and Today's briefing after. When no report is readable yet, the header says why beside Briefing not ready yet: the morning briefing is switched off, today's run failed or was blocked, it runs at the set time, or it should have run at that time. On a quiet day, when the briefing, the now-list and the evening review all have nothing to show, Today replaces their separate empty messages with one quiet line (the briefing's reason still shows in the header); as soon as any one of them has content, they all show as separate sections again. On a phone, the section links under the header, the add-medication plus button and the story links under each followed sports team each have a tap area at least 44 pixels tall, spaced at least 8 pixels from the next link. No text on Today is smaller than 11 pixels. The page header shows the title and the date under it (for example SUN · OCT 4) and has no settings cog, because this page has no settings of its own." +
      " Failed Today task completion restores the previous state and offers retry; confirmed writes refresh saved status. If today's saved plan cannot be read, Review task blocks says Today's plan couldn't be loaded and stays closed. If a task-block preview finds the calendar unavailable, selected choices stay, nothing is applied, and pressing Save changes requests a new preview. Morning handoff saves task blocks and reports this activation's outcomes: applied, failed, pending, need checking (sent with no report), not applied (never sent, such as a preview conflict or an unavailable calendar), confirmation needed, or denied.",
    path: "/today",
    scope: "user"
  },
  {
    id: "notifications",
    label: "Notifications",
    description:
      "Review notifications produced by enabled modules. Chat appears in the per-module notification switches and counts toward email digest availability. Quiet hours delay device alerts without hiding bell items that are already visible. The account menu button at the bottom of the rail shows the person's name and avatar only (no email line, unless no name is set) and the unread count as a badge when the menu is closed, and screen readers hear the number as part of the button's spoken label. The page header shows the title and the date under it (for example SUN · OCT 4) and has no settings cog, because this page has no settings of its own. How much Moss pushes to the phone is set in Settings under Notifications, as one saved choice per person: Quiet pushes only urgent items, Balanced (the default) pushes urgent and normal items but not low ones, and Proactive pushes everything. The same choice decides whether the summary sent when quiet hours end is sent for a deferred item. The list here and the daily briefing always show every notification whatever the level. The list distinguishes loading, no notifications and no unread notifications. A failed read offers Retry without reporting unknown counts as zero; marking an item read reports progress and failure beside that item, and a failed Mark all read reports its own error.",
    path: "/notifications",
    scope: "user"
  },
  {
    id: "settings",
    label: "Settings",
    description:
      "Personal and admin settings. Signup names the bootstrap owner only during initial setup; ordinary registration says Create account. Founder setup introduces an AI provider and optional Google calendar and email connection, with remaining setup available later in Settings. The finish screen reviews setup before completion is saved, and the member account recap distinguishes saved Google or email accounts, not connected, loading and failed reads. Google setup asks for an OAuth client ID and secret without making promises about third-party data paths, and distinguishes authorization instructions, ready and connecting states. Settings groups expose headings below the pane title. Onboarding completion failures retain progress and offer action-specific Retry; pending completion is shared across ordinary same-account re-entry, and only the current account and unchanged address may complete navigation. Pending or deactivated accounts offer read-only Check again and Sign out with pending and failure feedback; status text retains the latest confirmed account state. Unavailable module access or registry reads keep the requested address and offer Retry; gated pages mount only after explicit enablement. A search box on the top bar matches section names, descriptions and common setting words, and also matches every installed module that has its own settings to open (for example News) by that module's name, description, and the name of each individual setting or credential it declares (for example, searching a credential's own name like \"Plaid\" finds the module that uses it). A module with nothing to configure is left out of the results. Picking a result jumps straight to that module's settings. Modal dialogs keep keyboard focus inside when their focused control is disabled or removed, and Escape returns focus to the opener; nonmodal panels do not reclaim outside focus. Keyboard search keeps focus on the input and names the active result for assistive technology. On a phone, opening Settings with nothing chosen shows the full list of sections; choosing one folds the list into a bar that names the current section, and tapping that bar brings the list back as a sheet from the bottom, which closes with Escape or the close button. On a phone the AI provider actions (log in, terminal or test, edit, remove) sit in a More menu on each provider; on a wide screen they stay visible as buttons. While Moss is still loading, including when a section is opened directly by its address on a slow connection, the page shows a centred, gently animated Moss logo mark with the words Loading Moss instead of an empty page, and the section replaces it once it is ready. The page header shows the title and the date under it (for example SUN · OCT 4) and has no settings cog, because this page has no settings of its own.",
    path: "/settings",
    scope: "user"
  },
  {
    id: "chat-message",
    label: "Chat message link",
    description:
      "Opens one chat message from a link, such as a reminder's device alert or its View button in Notifications. A message in the person's own Main chat or side chat opens that chat in the drawer, scrolled to and focused on the message, over Notifications. A message that was deleted, sits in a deleted chat, or belongs to another account shows This message is not available with Open chat, and reveals nothing about it; any other failure shows Could not open this message with Retry.",
    path: "/chat/messages",
    scope: "user"
  },
  {
    id: "link-trail-marker",
    label: "Link a companion",
    description:
      "Approve or decline a Mac or Android ring companion asking to connect to this account. Android approval lists completed-recording uploads to Meetings, opted-in hold messages to Main and delivery/reply status; return to the phone and Start delivery afterward. Android cannot use Mac focus APIs or ordinary account/chat APIs. Both devices appear in Active sessions for revocation. Cancelling the original approval request also revokes a device issued by that request, including after approval expiry; the app must retain its private attempt proof until setup completes or cancellation is confirmed.  The Mac opens this screen with a request code in the address; the page names the Mac that is waiting and lists what a linked Mac will be able to do (check in and rename itself, read which focus block is on now, report which app is in front while one is on, and receive a nudge decision; on supported Macs, Record meetings when you choose Start) and says it never receives the account password or browser session. Approving links it and it then appears under Active sessions in Account & preferences, where it can be signed out. A request expires after ten minutes, and an expired, already-answered or unknown request says so and asks the person to start again from the Mac. Loading, submitting a decision and completion are announced. A closed or missing request asks for a new link; connection or server failure offers Retry to check the existing request again without approving it.",
    path: "/link/trail-marker",
    scope: "user"
  }
];

// Mirrors the real PERSONAL_GROUPS/ADMIN_GROUPS section ids and labels declared in
// apps/web/src/settings/settings-page.tsx — kept truthful to that file rather than
// any earlier draft, per #1110 spec anti-hallucination (settings-page.tsx is the
// source of truth for what a user can actually reach). Native Android settings
// identify the installed activity instead of inventing a web settings route.
export const CORE_APP_SETTINGS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "android-hardware",
    label: "Hardware (Moss for Android)",
    description:
      "Reached only inside the Android app: Settings, Connections, Hardware opens this native page (DeliveryActivity). The Hardware entry never shows in a browser. On first open the app shows Connect to Moss (one address field, then Moss's own approval page inside the app, signed in once); after that it opens the Moss site full screen at the connected address, with nothing about the ring outside Hardware, sends outside web links to the browser and mail or phone links to the system, and offers Open Hardware when Moss cannot load. The Android app id is ai.moss.android and it installs as a separate app from the earlier ring-only app. Ring setup is optional and starts from Hardware, Set up ring, at the Vocci account step; it never disconnects Moss, and until a ring is set up no ring service runs and no ring notification shows. Hardware starts with a status card that offers the one action for setup/recovery, account connection or pending browser approval (with text Cancel), competing Vocci access, missing permissions, background battery restriction, or Start/Stop delivery. Unreadable saved setup shows recovery text without a delivery action. Recent shows the latest three deliveries with time, kind, retained length when available and outcome; tapping a row opens recording details with Meeting or voice-request links and eligible Retry transcription. All deliveries keeps the previous 30-entry history reachable. Hardware also links to Recordings on ring. Delivery retrieves completed normal recordings into Meetings with retries and restart recovery after explicit opt-in; Hold-to-talk has separate enrollment and automatic normal Main chat inputs and text replies for new requests, with inline Send recovery for legacy pending transcripts. Saved battery, recording state, ring storage and installed firmware show when last observed, never a live connection inferred from old data. Recordings on ring explicitly refreshes actual saved audio sources even while delivery is stopped, with dated inventory, advertised audio/sidecar sizes and retained completion metadata where known. Inspect a recording to confirm a durable owner/ring/source exclusion from further delivery; a current request may finish first, and already sent bytes or existing Moss items cannot be recalled. Exclusion preserves phone/ring evidence, survives restart and reinventory, has no undo in this build, and prevents a failed hold transcription from being retried. The list pages at 25 sources. An optional phone reminder pops up with sound and vibration after the same named active recording is observed for an hour, repeats every 30 minutes until swiped away or tapped, clears once that recording is no longer observed, and never stops the recording; delivery and notification permission are required, and unknown status, gaps over two minutes or service restart reset the timer. Hardware holds Remind me after an hour, Voice messages (hold to talk), account name/origin and connected-account Disconnect, Set up ring again, About this ring, How to use your ring, Clear delivered audio (phone size, confirmed completed-copy cleanup and optional seven-day cleanup), and Permissions and battery. Ring and Moss copies stay intact. Permissions and battery explains Nearby devices, notifications, background battery use, competing Vocci access and account recovery. A ring guide covers recording, bookmarks and offline use; light and vibration meanings remain unverified, and vibration alone is not delivery confirmation. Ring setup uses the same flat native settings style: a saved connection shows its account/ring summary and current delivery state; Continue to Vocci ring returns Home, where daily actions live. Back from every Hardware subpage returns to Hardware, and Back on Hardware returns to Moss Settings. Fresh setup reveals sign-in/code controls only when needed and starts no email, delivery or enrollment on opening. Opening Hardware starts no delivery or hold enrollment. While delivery is on and the status card shows a blocker (cannot reach the ring, permission needed, account not connected, or setup could not be opened), a Ring problems phone notification repeats the card's text once and opens Hardware; it clears when the problem resolves or delivery stops. Individual ring deletion and firmware updating are unavailable in this build. This is a native Android surface; the web Settings page only links to it.",
    path: "android:ai.moss.android/.DeliveryActivity",
    scope: "user"
  },
  {
    id: "profile",
    label: "Account & preferences",
    description:
      "Edit personal profile and account details, time zone (proactive notes, notification quiet hours, medications, the day plan, the daily chat archive, outside-module schedules and the dates Moss gives the AI follow the saved time zone and 12/24-hour choice; with no time zone saved they use Pacific time, never the server's zone; weather guesses a city from the time zone only when one is saved), date format (region and 12/24-hour clock; chat answers, approval lines, Moss's current-time tool and approval card times show in this time zone and clock, except task and goal dates proposed in chat, which show as written, with Los Angeles and 24-hour as the default when nothing is saved), weather unit (Fahrenheit unless changed) and weather location (use the browser's location or search for a place; the hint under the location notes which of those two was used this session), a Quiet hours line naming the saved schedule (Saved schedule: every day, start to end, and its time zone; Nothing saved yet, so quiet hours are off. when none is saved; Loading quiet hours while it loads; the reason with Try again when it fails to load; Notifications follow instead of Saved schedule when part of the saved schedule cannot be read; and, while an older alert schedule differs, Notifications follow plus Email alerts follow a different saved schedule.) with Edit quiet hours opening Alerts & quiet hours, and it reloads after the profile time zone is saved, sessions, data export and account deletion. Recording cleanup runs before deletion: pending or changed note contributions retain the account and sessions, with Open Meetings guidance and a new confirmed request required to retry. A Trail Marker for Mac group explains the menu-bar Mac companion, says the app is not available to download yet, points to Trail Marker's Connect in Browser flow, describes how browser approval links a Mac and what the linked Mac may do, and points at Active sessions as the place a linked Mac appears and can be signed out. The single initial linking approval also authorizes recording on supported Macs, with Record meetings when you choose Start in its capabilities list. There is no separate recording approval card. Macs missing or with revoked recording authority must use Unlink Mac in Settings → Meetings and explicitly relink through Trail Marker; already-approved Macs remain linked. Connection alone never starts recording. Settings → Meetings shows Mac link status, the Audio source dropdown, Summarize automatically after Stop (on by default) and Unlink Mac. Turn the summary switch off to generate summaries only through Rewrite summary. New meetings default to microphone plus system audio; existing exact source choices stay in effect until changed. Meetings and Backtrack share the companion connection while Backtrack retains its own consent settings. During a meeting, the Meetings navigation dot and top-bar duration link back to the recording while you browse other modules. Pause and Stop stay on the meeting page; connection uncertainty and delayed transcription remain separate. Active sessions lists a linked Mac by the name it gave, with its app version. About the Mac app itself (not shown on this page): This Mac reads the actual macOS Start at login status, reports failed changes, and opens Login Items in System Settings for approval or recovery. Trail Marker only takes a picture of the exact window in front, and only when Accessibility is granted so it can identify that window (if it can't, it takes none; remedy: grant Trail Marker Accessibility in the Mac's System Settings); the server also accepts a window picture directly for a judge that reads pictures, as a third screenshot source alongside local and server descriptions (Trail Marker offers Your focus judge in Moss only when the configured judge reads pictures and names the model in consent; this source sends one allowed window picture directly through Moss without a describer or a key on the Mac; if a chosen judge stops reading pictures, the source stays selected but unavailable and no picture is sent, so choose an image-capable Classifier model in Settings → Admin → AI providers or another source; Test shows a thumbnail and the label with confidence without saving a focus judgment or affecting nudges; its thumbnail lives only in memory and clears on the next Test, pane close, disconnect or logout); its menu's Pause All pauses everything and sends nothing at all (its Test vision button then says to resume first), and a Focus switch in the menu pauses just Focus while staying connected (Test vision then says to switch Focus back on); logging out, or Moss revoking the Mac, clears its Focus settings on that Mac." +
      " Backtrack is currently a Debug-build-only preview in the Mac app's Settings, with separate consent and a menu switch. It reads the front window's visible text through Accessibility, skipping password fields, and uses on-device text recognition only when that gives too little. It keeps text in memory on that Mac until quit, with Show text and search; it does not yet upload anything. Moss can store Backtrack history only when an admin turns Backtrack storage on; Settings > Modules > Backtrack then shows and deletes it, kept 37 days, plus up to one hourly run. Chat cannot answer from it yet. Switches and periodic checks skip recently read similar screens, with a fresh read after at most five minutes; a window that keeps showing nothing new is read less often, and periodic reads wait while you type. After five minutes without keyboard or mouse input it stops recording; use the keyboard or mouse to resume within five seconds. Pause All, lock, sleep, missing permissions and Never watch exclusions also stop capture; resume, unlock or grant Accessibility and Screen Recording in Mac System Settings as appropriate. Turning Backtrack off, withdrawing consent, logging out or revoking the Mac clears remembered text." +
      " Data export includes supported records and regular owned private-vault Markdown originals, with an explicit completeness and exclusions manifest. External sources, attachments, non-note files and downloaded-module private data are omitted; it is not a restore backup. Restoring a saved export job checks the same job ID, offers Try again after unreadable checks and avoids duplicate starts. Ready archives honor their expiry deadline while this page stays open: Download disappears when an archive expires, and you can prepare a new archive without one starting automatically.",
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
      "Change the AI model for chat: choose which model answers, change model routing and response behavior. Admins also see Lock my own AI to one model here, for their own account only. A set lock wins over the chat model picker, which then turns off, and it covers chat, voice and background work; admins lock other people from People & access. The chat panel header and message box follow whether a chat model is available: with none, the header reads Not connected and a Connect a provider link to this screen replaces an empty message box; caller starters and unsent drafts remain editable, and with an admin-locked model that is unavailable, the header reads Model unavailable and the message box is disabled. When Auto-approve actions is on for your account, agent tool requests eligible for approval run without a confirmation card and are recorded as auto-approved in Activity. Unknown, unavailable, malformed, and forbidden-path requests remain refused. Turning Auto-approve actions off restores confirmation for the next eligible request. Also choose assistant behavior and response style (concise, balanced, or detailed, each shown with an example answer of that length) available to this user. Write the persona as free text or set it with guided dials. The preview area invites the user to press Preview until a real reply comes back, and shows the invitation again after the persona text, dials, or assistant name change. Preview a response with the selected chat provider; a CLI preview requires a supported ACP agent and a working sign-in and runner connection, which an admin can check in Admin > AI providers. Standalone numeric replies such as 4. stay visible in chat. Empty replies leave chat usable. The model button above the chat message box shows the selected model's readable name, falling back to the provider's model identifier and then to Instance default when no readable name is known. When a default chat model is set, a note explains that an admin must add a transcription model (in Admin > AI providers) to turn on the microphone in chat. Messages Moss sends on its own appear immediately, including while chat is starting, and missed messages are restored once when the stream opens or reconnects. The chat panel works with the keyboard: opening it moves focus into the message box (or onto the panel when the message box is replaced or disabled), Escape closes it and returns focus to the button that opened it, and on a phone Tab and Shift+Tab stay inside the open panel and screen readers treat it as a modal dialog, including beside a running draft. On a window 1280 pixels wide or more the chat panel sits beside the page and narrows it, so you can see the page while you chat. On narrower windows it floats over the right side of the page, except beside a running draft module, where it stays beside the page down to the phone width. Beside the page the chat panel is square-cornered and flush with the window edge, separated from the page by a single divider line, and its message box shows one outline. On a phone it is an overlay drawer that keeps its rounded floating shape. The chat panel header has four buttons: Conversations, Expand, More, and Close. Conversations opens a three-line overlay, covering the chat panel only and never the page beside it, with the durable Main chat and side chats; selecting your Main or one of your side chats activates its transcript, a chat another person shared with you is listed but does not open and the overlay stays open, and New side chat in the overlay starts a separate durable conversation. If the conversation list cannot load, it shows an error and Retry reloads it; if the selected transcript cannot load, its Retry reloads that transcript. More opens from the three-dot button and contains only Start private chat (the private chat toggle). On a desktop window with the chat docked beside the page, Expand makes the chat fill the whole main area, replacing the page header and page body while the left navigation stays, and Collapse in the same spot returns to the docked panel. Expanded chat reads in a centred column. Choosing another screen from the left navigation opens that screen and returns the chat to docked, keeping any unsent text, and closing the chat or reloading the app also returns it to docked. There is no Expand button on a phone. " +
      "Approval cards for app actions show the server-owned action title, full resolved target and exact requested changes as readable label and value rows, with Approve and Reject controls. Approve uses the normal primary style; deleting a saved memory or a note uses red. Note deletion states that it is permanent with no trash or undo. Approval buttons have a clear keyboard focus outline. File and shell permission cards use the same layout while retaining the exact path or command needed for the decision. Connected tools without an authored readable presentation show their complete validated arguments without truncation. A card shows one short notice about outside content only when that content is why it asks; a card that would ask in a fresh chat anyway shows no notice. A chat that holds outside content, which includes every chat on an outside agent such as Claude or Codex, still runs a change with no card when the user's own settings allow it: Auto-approve actions, an action group set or granted at install to run without asking (Settings preferences such as the theme are granted at install), or a module's freedom setting under its limit, such as Finance's per-move limit. With Auto-approve actions on, such a chat also runs connected tools, web lookups, and the outside agent's own file edits and web fetches with no card, as any other chat would, including connected tools that delete; the outside agent's commands, deletions and moves, and Moss's own deletions still ask. With it off, changes allowed only by Moss's own risk sorting, general app changes, sending or web lookups, and deletions still ask. When details are missing or cannot be fully disclosed, Approve is unavailable and Reject remains available; ask for a fresh request or use the app screen. Restored requests regain their normal card only when complete server details are available. Decided cards become one quiet result line without a selected-box outline; keyboard focus and announcements remain available. Successful chat actions refresh affected cached screens without a page reload. The assistant name set here replaces the word Moss in screen text across the app: the loading screen, the top bar, the browser tab title, settings, onboarding, Today and notifications. Text quoted in this map shows the default name Moss; a user who renamed their assistant sees that name instead. Before the name loads, screens show the last name saved in the browser, or Moss if none.",
    path: "/settings?section=assistant",
    scope: "user"
  },
  {
    id: "priorities",
    label: "Priorities",
    description:
      "Set goals and commitments the assistant should prioritize. Loading and failed reads are distinct from an empty list; Try again reloads unavailable priorities and failed writes retain their draft for another attempt.",
    path: "/settings?section=priorities",
    scope: "user"
  },
  {
    id: "memory",
    label: "Memory & context",
    description:
      "Review and configure assistant memory behaviour, and choose the People folder. Every " +
      "folder is chosen from the same list of available folders, and People notes live inside " +
      "the chosen notes folder. The dashboard distinguishes a failed read from no memories and offers Try again; previously loaded rows remain visible after a failed refresh. People folder, match-candidate and People-list reads also show failures with Try again.",
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
    id: "scheduled",
    label: "Scheduled tasks",
    description:
      "Inspect your chat reminders grouped under Reminders, Daily, Weekly and More often, with instruction, state, saved cadence, the next firing and up to 20 dated runs. Cadence times follow your 12-hour or 24-hour clock choice. One-time owner Tasks status checks also appear here. Main chat uses your configured model to select the task and time and saves directly. A current-source result links to Tasks; lost access and exhausted reads show a failed check with its honest message. Pause, resume and delete work the same way, and notification mutes and quiet hours still apply. Completed, expired and cancelled reminders stay under collapsed Past tasks. View message opens the saved result; Open chat opens its conversation. Loading and empty states are shown; a failed initial load offers Try again. A failed refresh keeps the loaded list, open details and message. Moss can read schedule facts and history dates from any chat, but saved message content stays on screen. Pause or resume pending reminders here or in Main chat. Resume keeps the saved time and sends an overdue reminder once unless its deadline passed. Delete task asks for confirmation with Keep task focused and keeps earlier messages and effects. In Main chat, delete/remove asks for a typed yes; cancel still cancels directly. These controls are not runs. Exact bounded task-status agreements appear separately under Approved changes - not active. Their stored task, operation, new status, time and version are inspectable, but they cannot run or resume. A failed change offers retry; refresh details if the reminder already finished.",
    path: "/settings?section=scheduled",
    scope: "user"
  },
  {
    id: "alerts",
    label: "Alerts & quiet hours",
    description:
      'Choose whether Moss checks connected email for useful automatic updates. With no saved applicable choice, email alerts are on when access is available; a saved off choice remains off. Automatic email alerts share a small daily and hourly limit: each email counts once, dismissing an alert does not free up room, a dismissed email alert never comes back, emails held by quiet hours appear at most one an hour after quiet hours end, and requested work never uses the limit. This choice does not grant email access or change requested work; device delivery, module mutes, and email digests remain in Notifications. Retry failed loading or saving (a save that collides with another change is refused with "Alert settings changed while saving. Reload and try again."), and recover unavailable access in Connections. If saved alert data is malformed, it remains protected for support repair. Quiet hours are edited here, beside the alert choice, and Account & preferences and Notifications link here. Quiet hours defer normal notifications until the selected local end. Enable quiet hours carries a Saved schedule line naming the stored schedule (every day, start to end, and its time zone or the profile time zone); with nothing saved it says Nothing saved yet, so quiet hours are off. Changing the switch, From, Until or Time zone makes a draft marked Unsaved changes, and nothing is stored until Save quiet hours; the Saved schedule line keeps naming the stored schedule meanwhile. An overnight window such as 22:00 to 07:00 is allowed. Saving the same start and end time says "Choose different start and end times." and sends nothing; a time outside 00:00 to 23:59 or an unknown time zone is refused the same way and nothing changes. With Profile time zone chosen, quiet hours follow the profile time zone, then the default time zone (Pacific time). A successful save says Quiet hours saved. A failed save says "Quiet hours could not save: <reason>. Your previous schedule still applies.", keeps the draft and offers Try again. If the schedule changed somewhere else since the draft began, even when the screen has since refreshed, the save is refused, the editor says "Quiet hours changed somewhere else, so this change was not saved. The latest schedule is showing now." and shows that latest schedule. While the schedule loads the controls say Loading quiet hours and stay held; a failed load shows the reason with Try again. Proactive cards follow the saved schedule in its own time zone, releasing at its local end. While an older alert schedule differs, the editor hides the form and says "Your saved quiet hours differ. Choose which schedule to use for future interruptions. Nothing changes until you choose." with one button per schedule, such as Keep quiet hours off, Turn quiet hours off or Use 23:00 to 08:00 (two off schedules name the window each keeps, as in Keep off (saved 23:00 to 08:00); a Profile window with its own time zone names the city of that zone, and the alert window beside it says Profile time zone). When only one schedule is left to offer, as when a chat edit made while they differed matches the alert schedule, the note instead says "Confirm your saved quiet hours to use them for future interruptions. Nothing changes until you confirm." over that one button. Until a choice saves, notifications keep the Profile schedule and proactive cards keep the older one; Moss in chat cannot make the choice, and a chat edit made while they differ changes only the notification schedule. Choosing makes that one schedule govern notifications, focus and proactive cards, and the editor says "Kept your saved quiet hours: <schedule>." or "Using your saved email alert schedule: <schedule>." and shows the form again. If the choice fails, both schedules stay in force, the buttons stay and the editor says "Your choice could not save: <reason>. Your previous schedules still apply." with Try again. If quiet hours changed somewhere else since the screen loaded, the choice is refused, the editor says "Quiet hours changed somewhere else, so your choice was not saved. The latest schedules are showing now." and shows them. Saving email alerts never settles the difference. An unsaved draft is dropped without a warning when you open another settings section. If part of the saved quiet hours cannot be read, the editor says "Part of your saved quiet hours could not be read. Notifications follow the schedule below." and the line under Enable quiet hours reads Notifications follow instead of Saved schedule. Allowed during quiet hours lists saved per-reminder choices, with loading, empty and retry states. Change in chat opens Main without sending a message. Exact owner-typed commands save or remove one choice; interpreted targets need a typed yes, and duplicate titles need one reminder ID. Model urgency never creates a choice. Module mutes and device controls still apply; only an allowed task skips quiet-hours deferral, with its saved choice and lifecycle checked again before device delivery.',
    path: "/settings?section=alerts",
    scope: "user"
  },
  {
    id: "connections",
    label: "Connections",
    description:
      "One pane for everything the assistant can reach outside itself, with three parts: Accounts, Notes folder, and Apps & services. " +
      "The pane opens with its title and connection counts. Accounts: connect external accounts and review their status. Outlook calendar uses a compact account row with a plain status indicator, read-only label, refresh coverage when available, and small sync/connect and disconnect buttons; failed saves offer a retry message. Add an email account by typing its address; Yahoo Mail, Proton Mail, iCloud and Fastmail addresses are recognised and get their mail server settings and app-password instructions filled in, other addresses choose the mail service by hand. " +
      "Notes folder: review sources the assistant can read and choose the notes folder, with one choose-a-folder explanation when no folder is linked. Every folder comes " +
      "from the same list of folders available on the server, and People notes live inside " +
      "the chosen notes folder. An info icon explains how folders get listed. Source reads distinguish checking, unknown after failure and a last-known path. Retry checks the current folder before changes are allowed. Changes stay disabled while a save is pending, even after leaving and returning, and an older source check cannot replace a confirmed save. Unlink announces success only after the folder change is saved. " +
      "Apps & services: connect external tools and services. The list distinguishes loading, a failed read and no connections; previously loaded connections stay visible after a failed refresh. Opening a connection fills the whole settings " +
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
      "Enable or disable user-toggleable modules. Every page header shows the page title with the date under it (for example SUN · OCT 4), including a Workshop project and the new-project page. Tasks, Calendar, Wellness, News and Sports also show a settings cog beside the title, which opens that module's own settings here. Today, The Workshop, Notifications and Settings have no cog because they have no settings of their own. A module that declares its own settings page sends its cog to that page, and this Modules list shows it as a link to the page instead of its own switches. Installed module pages can save through host-provided tools. Destructive and outbound actions open a Moss confirmation dialog with Confirm action and Cancel; the decision expires after two minutes. The host holds one operation at a time and drops open decisions on page or account changes. A failed or uncertain response asks the person to refresh and check the result before trying again, rather than repeating a write automatically. Older hosts without this handle cannot run these page actions.",
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
    description:
      "Manage instance users, access, and registration policy. The access notice distinguishes the bootstrap owner from other admins. New accounts appear here; sign-ups wait for approval only while approval is required. Failed member-list reads show an error with Try again rather than an empty instance; previously loaded members remain available during a failed refresh.",
    path: "/settings?section=people",
    scope: "admin"
  },
  {
    id: "aiproviders",
    label: "AI providers",
    description:
      "The Transcription group lets an admin choose one active OpenAI-compatible API provider and Voice-capable model for everyone's voice input and Meeting transcripts. Its short hint identifies the audio destination. Setup help appears when there are no eligible models and no saved model; recovery advice appears only after successful reads confirm the saved model is unavailable. Existing voice endpoint keeps the saved endpoint and key as the upgrade default; selecting it restores that configuration form. Admin locks take precedence. An unavailable selected model stops transcription without switching providers; choose another model or Existing voice endpoint to recover. Loading or failed provider/model reads disable saving and offer Retry. Audio uploads preserve their MIME type and use matching filenames for known containers. " +
      "Configure instance AI providers, models, and bindings. Native commands require a working host sandbox; on restricted Linux container hosts an administrator installs the native-sandbox security profiles and Compose overlay documented in docs/native-command-sandbox.md. That opt-in overlay also prepares read-only access to the chat owner's private vault for their isolated CLI account. Unexpected ACLs, linked files, excessive vault entries or failed preparation refuse the send; see the same guide for recovery. Each provider card lists its models " +
      "with a Refresh models button (asks the provider for its current list; the line under the " +
      "list then reads 'Refreshed: N models', 'Not logged in', 'This provider cannot list its " +
      "models yet', 'The sign-in helper is not running', 'The provider rejected the API key', or 'Could not reach the provider') and an " +
      "Add model button (type in a model by hand; such rows show a * after the id, the footer " +
      "reads '* Manually added', and they survive refreshes and re-logins). A decision model (the " +
      "System One provider kind) is offered as three choices under Decision models: Jev, Clef and " +
      "Any compatible service. Jev asks for an optional address and an API key; Clef asks for a " +
      "Cloudflare account ID and API token and builds the address from them; Any compatible " +
      "service asks for an address and an API key and stays addable more than once. A decision " +
      "model answers fixed named questions and is used only for the Trail Marker focus judgment " +
      "and the story and email sorting questions, not chat: its models are offered only in the " +
      "Classifier row and its card has no Set as default button. A model added by hand on a " +
      "decision model starts with the JSON capability and the Economy tier. When a decision-model " +
      "service has no model list, its Test line says the service does not list its models, so the " +
      "key could not be checked, and points to adding one by hand. The " +
      "Classifier row also sets the model " +
      "that judges Trail Marker focus; nothing is judged until an admin chooses one there. A decision model with image support can judge an allowed window picture directly when Your focus judge in Moss is explicitly chosen in the Mac Focus settings; the model name is shown in consent and a non-image model makes that source unavailable. Once " +
      "one is chosen it says Trail Marker's app and window titles also go to that model, or for " +
      "a decision model that they go to the chosen service (TypeSafe for Jev), which also answers " +
      "News, Sports and email " +
      "sorting questions. If that model can read pictures, such as Clef, the server also accepts " +
      "one picture of the window as focus evidence. The Mac app does not send it yet. " +
      "Each model row has " +
      "a Chat tag that is a toggle (on: users may pick the model for chat; off: the tag dims and " +
      "is struck through), " +
      "and an ACP note when the provider cannot honour a model choice, explaining that chat stays " +
      "on the login's default. The Providers header and the empty state each have an Add provider button that opens one " +
      "dialog with two steps. Choose lists Sign in with a subscription (Claude, Codex, Gemini, " +
      "OpenCode), Use an API key (OpenAI-compatible, Anthropic, Google, Ollama (local)) and " +
      "Decision models (Jev, Clef, Any compatible service); Connect starts with a Name field " +
      "prefilled with the next free name (Claude, then Claude 2) and shows only the fields that " +
      "choice needs, and Back returns to Choose. A subscription choice has no fields and ends in " +
      "the sign-in dialog. How a provider connects is fixed when it is added, so a card has no " +
      "Authentication switch and no CLI agent dropdown; to change method, remove the provider " +
      "and add it again. API key choices can be added any number of times. A subscription " +
      "choice that already has a provider is disabled with the line 'Already connected. Remove " +
      "it to sign in with another account.', because a second subscription of the same kind " +
      "would share the first sign-in. Anthropic by API key has an optional Base URL field that " +
      "points it at any Anthropic-compatible service; chat, background jobs and model lists use that address. " +
      "A provider address that includes a username or password is refused when saved. " +
      "An Anthropic or OpenAI-compatible API-key provider card also shows whether chat can use it. " +
      "When chat cannot, a line on the card reads 'The provider rejected the API key', 'Could " +
      "not reach the provider', 'No API key is saved', 'The chat program for this provider is " +
      "not installed', or 'The sign-in helper is not running'. The Codex ACP row hands " +
      "the instance's shared Codex connection into each user's own isolated runner home, " +
      "and provides a minus button (disable) and a trash button (remove after confirmation; the provider's " +
      "default entry cannot be removed). The Models section collapses from its header. CLI provider " +
      "cards run the ACP adapter's initialize check automatically and show 'Not logged in' when it is refused; " +
      "the Refresh models button only asks for the provider's current model list. A refresh the provider answers " +
      "by refusing the stored sign-in does not serve as the ACP login check. Once a provider has refused a " +
      "sign-in - on a model refresh, or on a chat message it would not answer - is recorded as a " +
      "provider rejection, distinct from a missing or malformed Codex runner credential. Chat checks CLI sign-ins when the " +
      "ACP adapter initializes. An OpenCode CLI provider appears as a normal provider card with " +
      "its own models, and chat uses the model chosen from that provider's model list. " +
      "Codex chat supports the newer models listed after a refresh without requiring a new sign-in or separate installation. " +
      "General live chat runs on a CLI provider or on an Anthropic or OpenAI-compatible API-key " +
      "provider. API-key chat runs the claude agent or OpenCode with the provider's saved address, " +
      "key and model, and keeps Moss tools and confirmation cards. " +
      "The normal docked drawer automatically attaches the open meeting as removable context, using its saved notes even before a transcript exists. Answers link transcript timestamps back to the exact line. These selected-meeting questions require the selected API-key chat model and run without tools; subscription meeting chat is not supported yet. Remove the About this meeting chip to continue ordinary chat with a subscription model. The chip announces the attached meeting title to screen readers. Failed meeting questions remain visible above their error in the open chat. A migrated legacy CLI provider without a supported " +
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
      "The page's second section, Which model does what, holds the Chat and briefing and Email reading rows, the Decision model row, and a Who can choose the chat model section with the switch that lets people choose their own chat model and the instance default. The lock that pins your own AI to one model, Lock my own AI to one model, now lives on Settings > Your assistant, where it wins over the chat model picker and covers chat, voice and background work. On phones its selector sits below its explanation. The lock control stays available when its model is unavailable, shows Locked model (unavailable) as the saved selection, and explains that the admin can clear the lock or turn the model back on. The Voice, Web search and Auto-approve actions sections start collapsed, each showing a one-line summary of its state, and remember open or closed per browser. The Email reading row: it reads the emails the classifier " +
      "cannot settle and writes their summaries and suggested actions. " +
      "The section ends its model rows with a Decision model row, that reads Not chosen until a model is picked. Choose a model opens a dialog listing every active " +
      "JSON-capable model equally, with nothing preselected and no recommendation, and Ask Moss to help opens the chat with an editable neutral draft that recommends no model. Use main model clears the choice. Under Advanced in the dialog, a Use in chat choice of Off, " +
      "Watch only or On shows once a model is selected. Before saving with Watch only or On, the dialog visibly names the current mode and says everyone's eligible chat messages go to the selected provider, even while Advanced is collapsed. Provider cards say Added for stored configurations; this does not claim that a connection has been tested. Use in chat is an instance-wide setting held through the admin " +
      "configuration boundary. If Use in chat cannot load, model selection is disabled and asks the admin to reload settings. Saving a different decision model first stops chat forwarding, then saves the model and intended chat mode; if a later save fails, forwarding remains off and the error identifies the saved mode. Any of Off, Watch only or On can be picked as soon as a classifier " +
      "is chosen, with no Watch only run or review first. With On, the classifier answers the chat " +
      "requests it is sure about and every other message goes to the main model. Once a model " +
      "is chosen, a line " +
      "under the row says story details, saved story preferences and each email's subject, " +
      "sender, dates and text go to that model first and to the main model if it does not " +
      "answer. For a decision model the line instead says it answers the News, Sports and " +
      "email sorting questions with a yes or no, that each email's subject, sender, dates and " +
      "text go there too, and that the main model still handles other sorting work. When a " +
      "hosted model is chosen and Use in chat is Watch only or On, the row also says eligible " +
      "chat messages go to its provider, and that when the gate is on every user's eligible " +
      "messages go to that provider. While Use in chat is Watch only, each eligible, non-private " +
      "message is also classified so the record shows whether the gate would have handled it; no " +
      "tool runs, no approval card appears and the main model still answers, and private chats and " +
      "oversized messages are never sent to the classifier. How long the gate waits for the " +
      "classifier follows that model's own measured speed per question. A fast model keeps a " +
      "short wait, so a one-off stall hands the message to the main model within a few " +
      "seconds; if stalls become frequent, the wait grows. A slower model is given about " +
      "twice the time a full tool request takes it, up to 30 seconds, and a signed-in " +
      "command-line model simply gets the full 30 seconds. After Moss restarts or a new " +
      "classifier model is chosen, the wait starts at 30 seconds while the model is measured, " +
      "and nothing about the wait can be set by hand. " +
      "The classifier " +
      "sorts each new email into junk, needs a reply, needs action, receipt or notice, " +
      "waiting on someone, time-sensitive, or for your information; receipts, order and booking " +
      "confirmations and account or policy notices stay kept and searchable but are left out of " +
      "the morning briefing. Mail it is unsure about, or all mail when it fails or none is " +
      "chosen, is sorted by the main model as before. A " +
      "Web search section (collapsed by default) has a 'Use your model's built-in web search' switch, on by " +
      "default, with a status line reading 'On, using Brave', 'On, using each person's chat " +
      "model', or 'Off. Add a Brave key or turn on built-in search.' A Brave Search API key " +
      "field below it is described as giving consistent results for every model, including " +
      "local ones. Shared CLI software is usable by separate Moss accounts; runner startup " +
      "automatically repairs the older installation-directory permission defect using the pinned " +
      "version, so users need no reinstall action. Only administrators can connect CLI providers. " +
      "The line under each CLI provider's name shows the installed tool and its version, for " +
      "example 'Claude CLI 2.1.282'. Installing Claude or Codex also installs the small chat helper that connects it " +
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
    description:
      "Review connector health across the instance. Loading, failed reads and an empty result are distinct; Try again reloads the report and previously loaded records remain visible after a failed refresh.",
    path: "/settings?section=oversight",
    scope: "admin"
  },
  {
    id: "audit",
    label: "Audit & operations",
    description:
      "Review instance audit and operational records. Failed reads offer Try again and do not look like an empty log; previously loaded records remain visible after a failed refresh.",
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
    code: "core.modules.confirmation_invalid",
    class: "permission",
    remediationRef: "core.modules.check_page_result",
    description:
      "A module-page confirmation expired, was cancelled, was already used, or does not match this operation. This request did not execute the tool."
  },
  {
    code: "core.modules.page_rate_limited",
    class: "transient",
    remediationRef: "core.modules.wait_before_page_change",
    description:
      "Too many module-page tool calls were made in the session/module limit window. The request is refused before execution."
  },
  {
    code: "core.modules.page_write_unavailable",
    class: "transient",
    remediationRef: "core.modules.check_page_result",
    description:
      "A module page could not obtain a confirmed result. A transport or result failure can occur after a write, so a failed response must not trigger an automatic retry."
  },
  {
    code: "android_hardware_status_unavailable",
    class: "transient",
    remediationRef: "android_hardware_status_recovery",
    description:
      "Native ring battery, storage or recording status has not been observed, or an optional response was malformed. Hardware keeps prior valid values with their observation times; audio delivery is not failed by missing telemetry."
  },
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
      "No chat model is available. The chat panel header reads Not connected, an empty message box is replaced by a Connect a provider link to Settings > Your assistant, and nothing can be sent. Caller starters are visible from the first render, and unsent drafts remain editable; user edits and explicit clears take precedence. An ordinary caller starter stays hidden when a private chat is already known."
  },
  {
    code: "core.ai.chat_locked_model_unavailable",
    class: "prerequisite",
    remediationRef: "core.ai.restore_locked_chat_model",
    description:
      "The chat model an admin locked is unavailable. The chat panel header reads Model unavailable, the message box is disabled, and a warning explains how to restore it."
  },
  {
    code: "core.ai.api_key_chat_provider_unsupported",
    class: "prerequisite",
    remediationRef: "core.ai.connect_cli_provider",
    description:
      "General live chat cannot start with an API-key provider of a type other than Anthropic or OpenAI-compatible. Selected-meeting questions are the separate API-key-only capability in the same drawer."
  },

  {
    code: "core.ai.api_key_rejected",
    class: "prerequisite",
    remediationRef: "core.ai.check_api_key",
    description:
      "The provider refused the saved API key during a chat. Chat reads 'The provider rejected " +
      "the API key. An admin can check it under Settings, AI providers.' When the saved key " +
      "cannot be read, chat reads 'The API key for this provider could not be read. An admin " +
      "can enter it again under Settings, AI providers.'"
  },

  {
    code: "core.ai.provider_address_has_login",
    class: "validation",
    description:
      "Saving an AI provider is refused when its address includes a username or password. The " +
      "message reads 'A provider address cannot include a username or password.' Remove them " +
      "from the address and save again."
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
    code: "core.ai.module_chat_identity_unavailable",
    class: "transient",
    remediationRef: "core.ai.retry_module_chat_identity",
    description:
      "A module chat cannot accept a new draft or message until its current conversation identity loads."
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
    id: "core.modules.check_page_result",
    description:
      "Refresh the module's data and check whether the change completed before starting a new operation. Review any new confirmation before continuing.",
    path: "/",
    scope: "user"
  },
  {
    id: "core.modules.wait_before_page_change",
    description: "Wait a minute before making another change on the module page.",
    path: "/",
    scope: "user"
  },
  {
    id: "android_hardware_status_recovery",
    description:
      "In Moss for Android, open Settings → Connections → Hardware → Permissions and battery. Allow Nearby devices, keep Bluetooth on and the ring nearby, and use Start delivery on Hardware for status refreshes. Hardware offers the matching fix for competing official Vocci access or account recovery; old observations remain explicitly dated.",
    path: "android:ai.moss.android/.DeliveryActivity",
    scope: "user"
  },
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
      "Keep or edit the unsent draft, then open Settings > Your assistant and restore a provider that can chat; sending resumes with that draft. When the message box is empty, press Connect a provider in the chat panel.",
    path: "/settings?section=assistant",
    scope: "user"
  },
  {
    id: "core.ai.restore_locked_chat_model",
    description:
      "Ask an administrator to re-enable the locked chat model or clear their own lock in Settings > Personal > Your assistant, or another user’s lock in People & access.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "core.ai.connect_cli_provider",
    description:
      "Ask an administrator to choose an Anthropic or OpenAI-compatible API-key provider, or a supported CLI provider, for general live chat.",
    path: "/settings?section=aiproviders",
    scope: "admin"
  },
  {
    id: "core.ai.check_api_key",
    description:
      "Ask an administrator to open Settings > AI providers, check the provider's API key with " +
      "Test, and enter a new key if it was rejected or cannot be read.",
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
    id: "core.ai.retry_module_chat_identity",
    description:
      "Press Retry in the module chat to load its current conversation identity; unsent drafts stay unchanged.",
    path: "/",
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
