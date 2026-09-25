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
      "Read the saved day plan as a schedule and preparation list with each block's state in words (committed versus proposed), plus a prominent weather row, a quick-actions dock with slot-placed module widgets, task and event details, email action rows, and goals. The morning briefing offers a full reader with sources and earlier reports, naming overnight changes to the saved evening plan. A Review task blocks button opens per-block placement and time choices with preview, one confirmation for moves and removals, and per-item outcomes. An Accept all time blocks button in the reader and the review applies every eligible proposed addition in one activation. A Plan tomorrow button opens an evening planning dialog with reflect, commitment, shape and review sections that saves tomorrow's intent and draft blocks in one action. A Chat with Moss button on the same card opens the evening interview carrying the saved plan, and can save intent and untimed additions for review without ever writing to the calendar. When the calendar or the saved plan cannot be read the schedule says so plainly instead of showing an empty day, and loaded events stay visible while the plan is still arriving.",
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
      "Change the AI model for chat: choose which model answers, change model routing and response behavior. Also choose assistant behavior, persona dials, and response style (concise, balanced, or detailed, each shown with an example answer of that length) available to this user. Selecting a Codex model clears a saved OpenCode chat choice. When a default chat model is set, a note explains that an admin must add a transcription model (in Admin > Assistant & AI) to turn on the microphone in chat.",
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
      "Trail Marker focus judgment and the story sorting questions, not chat: its models are " +
      "offered only in the Sorting model row and its card has no Set as default button. The " +
      "Sorting model row also sets the model " +
      "that judges Trail Marker focus; nothing is judged until an admin chooses one there. Once " +
      "one is chosen it says Trail Marker's app and window titles also go to that model, or for " +
      "a System One model that they go to TypeSafe, which also answers News and Sports sorting " +
      "questions. " +
      "Each model row has " +
      "a Chat tag that is a toggle (on: users may pick the model for chat; off: the tag dims and " +
      "is struck through), " +
      "and an ACP note when the provider cannot honour a model choice, explaining that chat stays " +
      "on the login's default. The page also identifies the OpenCode ACP card and its saved model setting, " +
      "and the normal Codex ACP row hands the signed-in credential into that user's isolated runner home, " +
      "and provides a minus button (disable) and a trash button (remove after confirmation; the provider's " +
      "default entry cannot be removed). The Models section collapses from its header. CLI provider " +
      "cards run the ACP adapter's initialize check automatically and show 'Not logged in' when it is refused; " +
      "the Refresh models button only asks for the provider's current model list. A refresh the provider answers " +
      "by refusing the stored sign-in does not serve as the ACP login check. Once a provider has refused a " +
      "sign-in - on a model refresh, or on a chat message it would not answer - is recorded as a " +
      "provider rejection, distinct from a missing or malformed Codex runner credential. Chat checks CLI sign-ins when the " +
      "ACP adapter initializes. The page also includes an OpenCode ACP card with a saved Chat model setting; " +
      "the saved choice is passed to the ACP chat launch and applied when the agent advertises that option. " +
      "Codex sign-in is per user and is checked in that user's isolated runner home; a missing or malformed " +
      "credential is reported as not signed in for that account rather than as a provider failure. " +
      "The current Codex sign-in surface is administrator-only under Settings, Assistant & AI, and " +
      "the administrator must use the same Moss account; other users do not have a recovery path there. " +
      "Pressing Log in on a provider " +
      "always re-checks the sign-in for real rather than reusing an old saved answer, so a " +
      "genuinely broken sign-in always gets a fresh place to sign back in. " +
      "The Services group ends with a Sorting model row: a dropdown with Use main model and " +
      "every active JSON-capable model, grouped by provider. Once a model is chosen, a line " +
      "under the row says story details and saved story preferences go to that model first and " +
      "to the main model if it does not answer. For a System One model the line instead says it " +
      "answers the News and Sports sorting questions with a yes or no, and the main model still " +
      "handles other sorting work. A " +
      "separate Web search group has a 'Use your model's built-in web search' switch, on by " +
      "default, with a status line reading 'On, using Brave', 'On, using each person's chat " +
      "model', or 'Off. Add a Brave key or turn on built-in search.' A Brave Search API key " +
      "field below it is described as giving consistent results for every model, including " +
      "local ones. Shared CLI software is usable by separate Moss accounts; runner startup " +
      "automatically repairs the older installation-directory permission defect using the pinned " +
      "version, so users need no reinstall action. Codex sign-in remains administrator-only for " +
      "the same account.",
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
  }
];

export const CORE_APP_REMEDIATIONS: readonly CoreAppRemediationDeclaration[] = [
  {
    id: "core.ai.ask_user",
    description: "Ask the user to approve the action before trying it again.",
    path: "/",
    scope: "user"
  }
];
