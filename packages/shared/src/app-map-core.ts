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
    description: "See the day's tasks, events, briefings, and priority cues in one place.",
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
      "Edit personal profile and account details, time zone, date format, weather unit (Fahrenheit unless changed) and weather location (use the browser's location or search for a place; the hint under the location notes which of those two was used this session), quiet hours, sessions, data export and account deletion.",
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
      "Choose assistant behavior, persona dials, response style (concise, balanced, or detailed, each shown with an example answer of that length), and model routing available to this user. Selecting a Codex model clears a saved OpenCode chat choice. When a default chat model is set, a note explains that an admin must add a transcription model (in Admin > Assistant & AI) to turn on the microphone in chat.",
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
      "models yet', 'The sign-in helper is not running', or 'Could not reach the provider') and an " +
      "Add model button (type in a model by hand; such rows show a * after the id, the footer " +
      "reads '* Manually added', and they survive refreshes and re-logins). Each model row has " +
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
      "genuinely broken sign-in always gets a fresh place to sign back in. A " +
      "separate Web search group has a 'Use your model's built-in web search' switch, on by " +
      "default, with a status line reading 'On, using Brave', 'On, using each person's chat " +
      "model', or 'Off. Add a Brave key or turn on built-in search.' A Brave Search API key " +
      "field below it is described as giving consistent results for every model, including " +
      "local ones.",
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
