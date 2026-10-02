import type { MeResponse } from "@moss/shared";

/** Shared props every settings pane receives from the shell. */
export interface PaneProps {
  readonly me: MeResponse;
  /** Navigate to an in-app route (used by "Open ↗" module links). */
  readonly onNavigate: (path: string) => void;
  /** Jump to another settings section (e.g. Modules → Memory & context). */
  readonly onSelectSection?: (id: string) => void;
}

/** Editorial one-liners for modules (the module DTOs carry no description). */
export function moduleDescriptions(assistantName: string): Record<string, string> {
  return {
    tasks: "Capture, prioritise and track what you need to do.",
    calendar: `The events ${assistantName} plans around and protects.`,
    briefings: "Your daily reading ritual. Cadence lives in here.",
    knowledge: `What ${assistantName} remembers about you — facts, patterns, corrections.`,
    wellness: "Private capacity signals — mood, energy, meds.",
    notifications: "What's worth surfacing. Sensitivity lives in here.",
    finance: "Planning context, kept out of your briefings.",
    email: "Lets the assistant read your mail for context and turn messages into tasks.",
    news: "Follow the sources you pick and read their latest stories in one place.",
    chat: "The assistant you talk to, inside the product."
  };
}

export function moduleDescription(id: string, assistantName: string): string {
  return moduleDescriptions(assistantName)[id] ?? "An add-on module.";
}

export function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
