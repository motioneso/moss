import type { StandingsSection } from "@moss/shared";

// A pickable standings view: either the whole league ("All"), a whole conference, or a single
// division/group. `conference` buckets the option under an <optgroup>; null renders it top-level.
export interface StandingsView {
  readonly key: string;
  readonly label: string;
  readonly conference: string | null;
  readonly sections: readonly StandingsSection[];
}

// US leagues nest divisions under conferences (AFC/NFC → AFC East…); soccer group stages are flat.
// "All" first, then per conference a whole-conference option followed by its divisions; flat tables
// collapse to "All" + one option per group. Works when `conference` is absent (older payloads).
export function buildViews(sections: readonly StandingsSection[]): StandingsView[] {
  if (sections.length === 0) return [];
  const all: StandingsView = { key: "all", label: "All", conference: null, sections };
  const hasConference = sections.some((section) => section.conference);
  if (!hasConference) {
    if (sections.length === 1) return [all];
    return [
      all,
      ...sections.map((section, index) => ({
        key: `sec:${index}`,
        label: section.label ?? `Group ${index + 1}`,
        conference: null,
        sections: [section]
      }))
    ];
  }
  const order: string[] = [];
  const byConference = new Map<string, { section: StandingsSection; index: number }[]>();
  sections.forEach((section, index) => {
    const conference = section.conference ?? "";
    if (!byConference.has(conference)) {
      byConference.set(conference, []);
      order.push(conference);
    }
    byConference.get(conference)?.push({ section, index });
  });
  const views: StandingsView[] = [all];
  for (const conference of order) {
    const members = byConference.get(conference) ?? [];
    if (conference) {
      views.push({
        key: `conf:${conference}`,
        label: conference,
        conference,
        sections: members.map((m) => m.section)
      });
    }
    for (const { section, index } of members) {
      views.push({
        key: `sec:${index}`,
        label: section.label ?? `Group ${index + 1}`,
        conference: conference || null,
        sections: [section]
      });
    }
  }
  return views;
}
