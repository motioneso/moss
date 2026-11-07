import type { DataContextDb } from "@moss/db";

import type {
  CalendarContextItem,
  ContextWindow,
  MemoryContextItem,
  OwnerContextSources,
  PersonContextItem
} from "./context-pack-port.js";
import { looksLikeOrder } from "./instruction-scan.js";

export interface OwnerContextPack {
  readonly owner: { readonly displayName: string; readonly aliases: readonly string[] };
  readonly event: CalendarContextItem | null;
  readonly people: readonly PersonContextItem[];
  readonly facts: readonly MemoryContextItem[];
}

export type ContextSource = "calendar" | "people" | "memory";

export interface BuiltContextPack {
  readonly pack: OwnerContextPack;
  /** True when anything was dropped for size. */
  readonly trimmed: boolean;
  /** Source and count only. The matching text never leaves this module. */
  readonly scanHits: readonly { readonly source: ContextSource; readonly count: number }[];
}

export const CONTEXT_CAPS_BYTES = {
  owner: 1024,
  calendar: 4096,
  people: 6144,
  memory: 6144
} as const;

const MAX_NAMES = 30;
const MAX_NAME_LENGTH = 80;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const NAME_STOPWORDS = new Set(
  "I,The,A,An,And,But,So,Or,If,It,We,You,They,He,She,This,That,Then,Yeah,Yes,No,Okay,Ok,Well,Right,Also,Just,Now,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday,January,February,March,April,May,June,July,August,September,October,November,December".split(
    ","
  )
);

/** Capitalised names heard in the talk, in first-seen order. Plain string work, no model call. */
export function extractTranscriptNames(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const text of texts) {
    const pattern = /[A-Z][a-z]+(?:[ \t][A-Z][a-z]+){0,2}/g;
    for (const match of text.matchAll(pattern)) {
      const words = match[0].split(/\s+/);
      const wordCount = words.length;
      while (words.length > 0 && NAME_STOPWORDS.has(words[0]!)) words.shift();
      if (words.length === 0) continue;
      const name = words.join(" ");
      const single = !/\s/.test(name);
      if (single && NAME_STOPWORDS.has(name)) continue;
      const before = text.slice(0, match.index).trimEnd();
      const startsSentence = before === "" || /[.!?]$/.test(before);
      if (single && startsSentence && words.length === wordCount) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= MAX_NAMES) return names;
    }
  }
  return names;
}

const settle = async <T>(work: () => Promise<readonly T[]>): Promise<readonly T[]> => {
  try {
    return await work();
  } catch {
    return [];
  }
};

const dropLastUntil = <T>(items: readonly T[], capBytes: number): readonly T[] => {
  const kept = [...items];
  while (kept.length > 0 && bytes(kept) > capBytes) kept.pop();
  return kept;
};

const cutText = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** Lowest rank is last. Returns the pack plus whether any source went over its own cap. */
function capSources(pack: OwnerContextPack): { pack: OwnerContextPack; trimmed: boolean } {
  let event = pack.event;
  if (event) {
    const attendeeNames = dropLastUntil(event.attendeeNames, CONTEXT_CAPS_BYTES.calendar - 512);
    event = { ...event, title: cutText(event.title, 240), attendeeNames };
    if (bytes(event) > CONTEXT_CAPS_BYTES.calendar) event = null;
  }
  const people = dropLastUntil(pack.people, CONTEXT_CAPS_BYTES.people);
  const facts = dropLastUntil(pack.facts, CONTEXT_CAPS_BYTES.memory);
  const trimmed =
    event?.attendeeNames.length !== pack.event?.attendeeNames.length ||
    (pack.event !== null && event === null) ||
    people.length !== pack.people.length ||
    facts.length !== pack.facts.length;
  return { pack: { ...pack, event, people, facts }, trimmed };
}

/**
 * Drops pack items until the pack fits. Facts go first, then people, then the event, each from
 * the lowest rank (last) up. Returns null when the owner entry alone does not fit.
 */
export function fitContextPack(
  pack: OwnerContextPack,
  budgetBytes: number
): { pack: OwnerContextPack | null; trimmed: boolean } {
  if (bytes(pack) <= budgetBytes) return { pack, trimmed: false };
  const facts = [...pack.facts];
  const people = [...pack.people];
  let event = pack.event;
  const current = (): OwnerContextPack => ({ owner: pack.owner, event, people, facts });
  while (bytes(current()) > budgetBytes && facts.length > 0) facts.pop();
  while (bytes(current()) > budgetBytes && people.length > 0) people.pop();
  if (bytes(current()) > budgetBytes) event = null;
  if (bytes(current()) > budgetBytes) return { pack: null, trimmed: true };
  return { pack: current(), trimmed: true };
}

/** Counts lines that look like orders, per source. Text never leaves this function. */
export function scanContextPack(pack: OwnerContextPack): BuiltContextPack["scanHits"] {
  const count = (texts: readonly (string | null | undefined)[]) =>
    texts.reduce<number>((total, text) => {
      if (!text) return total;
      return total + text.split(/\r?\n/).filter((line) => looksLikeOrder(line)).length;
    }, 0);
  const counts: Record<ContextSource, number> = {
    calendar: count(pack.event ? [pack.event.title, ...pack.event.attendeeNames] : []),
    people: count(pack.people.flatMap((p) => [p.name, p.role, p.note])),
    memory: count(pack.facts.map((f) => f.text))
  };
  return (["calendar", "people", "memory"] as const)
    .filter((source) => counts[source] > 0)
    .map((source) => ({ source, count: counts[source] }));
}

/**
 * Builds the owner context for one piece of a recording. A source that throws counts as empty,
 * so nothing here can fail a summary.
 */
export async function buildOwnerContextPack(
  sources: OwnerContextSources,
  db: DataContextDb,
  input: { readonly transcriptNames: readonly string[]; readonly window: ContextWindow }
): Promise<BuiltContextPack> {
  const profile = await sources.ownerProfile(db).catch(() => ({ displayName: "", aliases: [] }));
  const owner = {
    displayName: cutText(profile.displayName, MAX_NAME_LENGTH),
    aliases: profile.aliases.slice(0, 5).map((a) => cutText(a, MAX_NAME_LENGTH))
  };
  const events = await settle(() => sources.calendar(db, input.window));
  const event = events.length === 1 ? events[0]! : null;

  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of [...(event?.attendeeNames ?? []), ...input.transcriptNames]) {
    const clean = name.trim().slice(0, MAX_NAME_LENGTH);
    if (clean === "" || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    names.push(clean);
    if (names.length >= MAX_NAMES) break;
  }
  const people = names.length > 0 ? await settle(() => sources.people(db, names)) : [];
  const queries = [...(event ? [event.title] : []), ...names];
  const facts = queries.length > 0 ? await settle(() => sources.memory(db, queries)) : [];

  const raw: OwnerContextPack = { owner, event, people, facts };
  const capped = capSources(raw);
  return {
    pack: capped.pack,
    trimmed: capped.trimmed,
    scanHits: scanContextPack(capped.pack)
  };
}
