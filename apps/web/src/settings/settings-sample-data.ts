/* Representative sample data for settings surfaces whose backend is not yet
   wired (see 2026-06-14 settings design handoff — items marked 🔌). Shapes
   mirror the design kit's fake data; values are illustrative. These power the
   click-through of the data-export job, the server-side vault chooser, and the
   per-module setting sub-views until the endpoints land. (Active sessions is now
   wired to /api/me/sessions — see settings-profile-subviews.tsx.) */

/* ----------------------------------------------------- Server filesystem */

export interface ServerRoot {
  readonly name: string;
  readonly label: string;
  readonly writable: boolean;
  readonly note?: string;
}

export interface ServerNode {
  readonly name: string;
  readonly type: "dir" | "file";
  readonly mdCount?: number;
}

export interface ServerFs {
  readonly roots: readonly ServerRoot[];
  readonly tree: Readonly<Record<string, readonly ServerNode[]>>;
}

// Intentionally empty — no fabricated host filesystem. Populated by a real host-fs
// listing API when it exists (BACKEND-TODO). Types kept to document the shape.
export const SERVER_FS: ServerFs = { roots: [], tree: {} };

export const DEFAULT_VAULT = {
  linked: false,
  folder: "",
  mount: "",
  fileCount: 0,
  writable: false
};

export interface VaultBehavior {
  readonly k: string;
  readonly name: string;
  readonly desc: string;
  readonly on: boolean;
}

export const VAULT_BEHAVIORS: readonly VaultBehavior[] = [
  {
    k: "context",
    name: "Use for context & answers",
    desc: "Read your notes to ground answers and the briefing in what you already know.",
    on: true
  },
  {
    k: "surface",
    name: "Surface relevant notes",
    desc: "Bring up a note when it relates to what you're doing today.",
    on: true
  },
  {
    k: "capture",
    name: "Capture tasks from notes",
    desc: "Turn unchecked to-dos in your notes into tasks.",
    on: false
  },
  {
    k: "writeback",
    name: "Write notes back",
    desc: "Let your assistant append summaries or notes to your folder.",
    on: false
  }
];

/* ------------------------------------------------- Per-module settings */

export interface BriefingSection {
  readonly k: string;
  readonly name: string;
  readonly desc: string;
  readonly on: boolean;
}

export interface BriefingsSettings {
  readonly morningTime: string;
  readonly eveningOn: boolean;
  readonly eveningTime: string;
  readonly depth: "brief" | "full";
  readonly readAloud: boolean;
  readonly sections: readonly BriefingSection[];
}

export const DEFAULT_BRIEFINGS: BriefingsSettings = {
  morningTime: "06:30",
  eveningOn: true,
  eveningTime: "21:00",
  depth: "full",
  readAloud: false,
  sections: [
    {
      k: "calendar",
      name: "Today's calendar",
      desc: "Your events, and the gaps your assistant is protecting.",
      on: true
    },
    {
      k: "priorities",
      name: "Priorities",
      desc: "The handful of things that matter most today.",
      on: true
    },
    {
      k: "email",
      name: "Email needing a reply",
      desc: "Threads flagged as needing you today.",
      on: true
    },
    {
      k: "wellness",
      name: "Wellness check-in",
      desc: "A gentle read on capacity before the day starts.",
      on: true
    },
    { k: "weather", name: "Weather", desc: "A one-line look at the day ahead.", on: false }
  ]
};

export type NotificationSensitivity = "quiet" | "balanced" | "proactive";

export function notificationSensitivityHint(
  assistantName: string
): Record<NotificationSensitivity, string> {
  return {
    quiet: "Only what's genuinely urgent. Everything else waits for your briefing.",
    balanced: "The default. Timely nudges, without the noise.",
    proactive: `${assistantName} speaks up early and often. Best when you want maximum coverage.`
  };
}
