#!/usr/bin/env node
// Builds this week's digest content from the release notes that pull requests already carry.
//
// Every pull request fills in a "Release note" section — a category, a title, and a one-sentence
// description written for people who don't read code. That is exactly what the weekly page needs,
// so the page is assembled from those rather than written again by hand.
//
//   node collect.mjs --friday 2026-08-21 [--repo owner/name] > content.json
//
// Prints nothing and exits 0 when no user-facing pull requests merged in the window.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseNote } from "../../scripts/append-release-note.mjs";

const CATEGORY_SECTIONS = { Added: "New", Changed: "Improved" };

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The window is the seven days ending at 06:00 Pacific on the given Friday. */
export function window(fridayIso) {
  const end = zonedFriday(fridayIso);
  const start = new Date(end.getTime() - 7 * 86400000);
  return { start, end };
}

function zonedFriday(fridayIso) {
  // Pacific is UTC-7 or UTC-8; work out which by asking what 06:00 local is in UTC that day.
  for (const offset of [7, 8]) {
    const guess = new Date(`${fridayIso}T${String(6 + offset).padStart(2, "0")}:00:00Z`);
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "2-digit",
        hour12: false
      }).format(guess)
    );
    if (localHour === 6) return guess;
  }
  throw new Error(`Could not place 06:00 Pacific on ${fridayIso}`);
}

function mergedPullRequests(repo, start, end) {
  const search = `merged:${start.toISOString().slice(0, 19)}Z..${end.toISOString().slice(0, 19)}Z`;
  const output = execFileSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      "200",
      "--search",
      search,
      "--json",
      "number,body,url,mergedAt"
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(output);
}

/** Groups parsed notes into the page's sections. Titles that repeat across pull requests are
 * merged into one entry carrying both links, which is common for a feature landing in slices. */
export function build(notes) {
  const sections = new Map();
  const fixes = new Map();

  for (const { note, number } of notes) {
    if (note.category === "Fixed") {
      const key = note.description;
      const existing = fixes.get(key);
      if (existing) existing.prs.push(number);
      else fixes.set(key, { text: note.description, prs: [number] });
      continue;
    }
    const sectionName = CATEGORY_SECTIONS[note.category];
    if (!sectionName) continue;
    if (!sections.has(sectionName)) sections.set(sectionName, new Map());
    const items = sections.get(sectionName);
    const existing = items.get(note.title);
    if (existing) existing.prs.push(number);
    else items.set(note.title, { title: note.title, body: note.description, prs: [number] });
  }

  const ordered = ["New", "Improved"]
    .filter((name) => sections.has(name))
    .map((name) => ({ title: name, items: [...sections.get(name).values()] }));

  const counts = [
    ordered.find((s) => s.title === "New")?.items.length,
    ordered.find((s) => s.title === "Improved")?.items.length,
    fixes.size
  ];
  const phrases = [
    counts[0] ? `${counts[0]} new ${counts[0] === 1 ? "thing" : "things"}` : null,
    counts[1] ? `${counts[1]} ${counts[1] === 1 ? "improvement" : "improvements"}` : null,
    counts[2] ? `${counts[2]} ${counts[2] === 1 ? "fix" : "fixes"}` : null
  ].filter(Boolean);
  const list =
    phrases.length > 1 ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}` : phrases[0];

  // The headline is the week's first new feature, or its first improvement in a quiet week.
  const headlineSource = ordered[0]?.items[0];
  if (!headlineSource) return null;
  const rest = ordered
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item !== headlineSource)
    }))
    .filter((section) => section.items.length);

  return {
    summary: `${list.charAt(0).toUpperCase()}${list.slice(1)} this week, starting with ${headlineSource.title.toLowerCase()}.`,
    intro: `${list.charAt(0).toUpperCase()}${list.slice(1)} landed this week. The headline is below, everything else follows, and the fixes are at the bottom if that is all you are here for.`,
    headline: { title: headlineSource.title, body: [headlineSource.body], prs: headlineSource.prs },
    sections: rest,
    fixes: [...fixes.values()]
  };
}

function main() {
  const friday = argument("--friday");
  if (!friday) {
    console.error("Usage: collect.mjs --friday <YYYY-MM-DD> [--repo owner/name]");
    process.exit(2);
  }
  const repo =
    argument("--repo") ??
    execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      encoding: "utf8"
    }).trim();
  const { start, end } = window(friday);
  const notes = mergedPullRequests(repo, start, end)
    .map((pr) => ({ number: pr.number, note: parseReleaseNote(pr.body) }))
    .filter((entry) => entry.note !== null);

  const content = build(notes);
  if (!content) {
    console.error("No user-facing changes merged in the window");
    return;
  }
  console.log(JSON.stringify(content, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
