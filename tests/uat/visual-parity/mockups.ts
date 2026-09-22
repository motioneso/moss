// tests/uat/visual-parity/mockups.ts
//
// VP-P0: the 32 approved mockups, each with viewport, study region (spec 3.1)
// and the state-driving step. Weather variants center-crop the opening clip
// to the mockup size; the crop is documented, not exact.
export interface Viewport {
  readonly w: number;
  readonly h: number;
}
export type Region =
  | {
      readonly kind: "clip";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly crop?: { readonly w: number; readonly h: number };
    }
  | { readonly kind: "element"; readonly selector: string };
export interface MockupEntry {
  readonly name: string;
  readonly dir: string;
  readonly viewport: Viewport;
  readonly region: Region;
  readonly state: string;
  readonly clock: "morning" | "evening";
}
const D = '[role="dialog"]';
const T = "2026-09-10-today-briefings",
  M = "2026-09-10-morning-briefing",
  E = "2026-09-10-evening-planning";
const V1440: Viewport = { w: 1440, h: 1000 },
  V375: Viewport = { w: 375, h: 1000 };
const OPEN1440: Region = { kind: "clip", x: 194, y: 64, w: 1246, h: 850 };
const OPEN375: Region = { kind: "clip", x: 0, y: 0, w: 375, h: 850 };
function weather(region: Region, w: number, h: number): Region {
  return region.kind === "clip" ? { ...region, crop: { w, h } } : region;
}
export const MOCKUPS: readonly MockupEntry[] = [
  {
    name: "morning-1440-opening.png",
    dir: T,
    viewport: V1440,
    region: OPEN1440,
    state: "today-morning",
    clock: "morning"
  },
  {
    name: "morning-375-opening.png",
    dir: T,
    viewport: V375,
    region: OPEN375,
    state: "today-morning",
    clock: "morning"
  },
  {
    name: "morning-1440-opening-weather.png",
    dir: T,
    viewport: V1440,
    region: weather(OPEN1440, 1185, 495),
    state: "today-morning",
    clock: "morning"
  },
  {
    name: "morning-375-opening-weather.png",
    dir: T,
    viewport: V375,
    region: weather(OPEN375, 345, 608),
    state: "today-morning",
    clock: "morning"
  },
  {
    name: "morning-1440-news.png",
    dir: T,
    viewport: V1440,
    region: { kind: "clip", x: 0, y: 0, w: 1440, h: 850 },
    state: "today-morning-news",
    clock: "morning"
  },
  {
    name: "morning-375-news.png",
    dir: T,
    viewport: V375,
    region: OPEN375,
    state: "today-morning-news",
    clock: "morning"
  },
  {
    name: "morning-1440-sports.png",
    dir: T,
    viewport: V1440,
    region: { kind: "clip", x: 194, y: 0, w: 1246, h: 850 },
    state: "today-morning-sports",
    clock: "morning"
  },
  {
    name: "morning-375-sports.png",
    dir: T,
    viewport: V375,
    region: OPEN375,
    state: "today-morning-sports",
    clock: "morning"
  },
  {
    name: "evening-1440-opening.png",
    dir: T,
    viewport: V1440,
    region: OPEN1440,
    state: "today-evening",
    clock: "evening"
  },
  {
    name: "evening-375-opening.png",
    dir: T,
    viewport: V375,
    region: OPEN375,
    state: "today-evening",
    clock: "evening"
  },
  {
    name: "1440-proposed-read.png",
    dir: M,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "reader-proposed-read",
    clock: "morning"
  },
  {
    name: "375-proposed-read.png",
    dir: M,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "reader-proposed-read",
    clock: "morning"
  },
  {
    name: "1440-proposed-review.png",
    dir: M,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "reader-proposed-review",
    clock: "morning"
  },
  {
    name: "375-proposed-review.png",
    dir: M,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "reader-proposed-review",
    clock: "morning"
  },
  {
    name: "1440-news.png",
    dir: M,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "reader-news-links",
    clock: "morning"
  },
  {
    name: "375-sports.png",
    dir: M,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "reader-sports-links",
    clock: "morning"
  },
  {
    name: "partial-review.png",
    dir: M,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "reader-partial-review",
    clock: "morning"
  },
  {
    name: "1440-automatic-read.png",
    dir: M,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "reader-automatic-read",
    clock: "morning"
  },
  {
    name: "375-automatic-read.png",
    dir: M,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "reader-automatic-read",
    clock: "morning"
  },
  {
    name: "1440-automatic-review.png",
    dir: M,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "reader-automatic-review",
    clock: "morning"
  },
  {
    name: "375-automatic-review.png",
    dir: M,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "reader-automatic-review",
    clock: "morning"
  },
  {
    name: "1440-0.png",
    dir: E,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "evening-step-0",
    clock: "evening"
  },
  {
    name: "375-0.png",
    dir: E,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "evening-step-0",
    clock: "evening"
  },
  {
    name: "1440-1.png",
    dir: E,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "evening-step-1",
    clock: "evening"
  },
  {
    name: "375-1.png",
    dir: E,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "evening-step-1",
    clock: "evening"
  },
  {
    name: "1440-2.png",
    dir: E,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "evening-step-2",
    clock: "evening"
  },
  {
    name: "375-2.png",
    dir: E,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "evening-step-2",
    clock: "evening"
  },
  {
    name: "1440-3.png",
    dir: E,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "evening-step-3",
    clock: "evening"
  },
  {
    name: "375-3.png",
    dir: E,
    viewport: V375,
    region: { kind: "element", selector: D },
    state: "evening-step-3",
    clock: "evening"
  },
  {
    name: "changed-plan-review.png",
    dir: E,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "evening-step-3",
    clock: "evening"
  },
  {
    name: "changed-plan-saved.png",
    dir: E,
    viewport: V1440,
    region: { kind: "element", selector: D },
    state: "evening-saved",
    clock: "evening"
  },
  {
    name: "changed-plan-handoff-phone.png",
    dir: E,
    viewport: V375,
    region: OPEN375,
    state: "evening-saved",
    clock: "evening"
  }
];
