#!/usr/bin/env node
// Pulls the "Release note" section out of a pull request body and appends it to
// docs/WHATS_NEW.md's edge-channel section. Silently does nothing when a pull request has no
// release note (internal/non-user-facing change) — that is the normal case, not an error.
//
// The release-notes workflow runs this on its serialized automation branch after a merge. It is
// also safe to run locally with --pr or explicit metadata flags while developing the transformer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORIES = ["Added", "Fixed", "Changed"];
const WHATS_NEW_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "WHATS_NEW.md"
);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Returns null when the pull request body has no usable release note (the normal case). */
export function parseReleaseNote(body) {
  if (!body) return null;
  const section = body.match(/^##\s*Release note\s*$([\s\S]*?)(?:^##\s|$(?![\s\S]))/im);
  const text = section ? section[1] : body;

  const category = text.match(/^Category:\s*(\S.*)$/im)?.[1]?.trim();
  if (!category || !CATEGORIES.includes(category)) return null;

  const title = text.match(/^Title:\s*(\S.*)$/im)?.[1]?.trim();
  const description = text.match(/^Description:\s*(\S.*)$/im)?.[1]?.trim();
  if (!title || !description) return null;

  return { category, title: title.replace(/\.+$/, ""), description };
}

function todayPacificDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

/** Inserts the new bullet under the edge channel's date and category headings. */
export function appendReleaseNote(markdown, note, { prNumber, prUrl, today }) {
  const bullet = `- **${note.title}.** ${note.description} [PR #${prNumber}](${prUrl})`;

  const edgeMatch = markdown.match(/^## Edge channel(?: — (\S+))?\n/m);
  assert.ok(edgeMatch, "docs/WHATS_NEW.md is missing its '## Edge channel' heading");
  const edgeStart = edgeMatch.index;
  const nextTopHeadingIndex = markdown.indexOf("\n## ", edgeStart + edgeMatch[0].length);
  const edgeEnd = nextTopHeadingIndex === -1 ? markdown.length : nextTopHeadingIndex + 1;

  let edgeSection = markdown
    .slice(edgeStart, edgeEnd)
    .replace(/^## Edge channel(?: — \S+)?/, "## Edge channel");

  const legacyDate = edgeMatch[1];
  const hasDateGroup = /^### \d{4}-\d{2}-\d{2}$/m.test(edgeSection);
  if (legacyDate && !hasDateGroup) {
    edgeSection = edgeSection.replace(
      /^(### (?:Added|Fixed|Changed))$/m,
      `### ${legacyDate}\n\n$1`
    );
  }
  edgeSection = edgeSection.replace(/^### (Added|Fixed|Changed)$/gm, "#### $1");

  if (edgeSection.includes(`[PR #${prNumber}]`)) return markdown;

  const dateHeading = `### ${today}`;
  const categoryHeading = `#### ${note.category}`;
  const dateIndex = edgeSection.indexOf(`${dateHeading}\n`);
  if (dateIndex !== -1) {
    const nextDateMatch = edgeSection
      .slice(dateIndex + dateHeading.length)
      .match(/^### \d{4}-\d{2}-\d{2}$/m);
    const nextDateIndex = nextDateMatch ? dateIndex + dateHeading.length + nextDateMatch.index : -1;
    const dateEnd = nextDateIndex === -1 ? edgeSection.length : nextDateIndex;
    const dateSection = edgeSection.slice(dateIndex, dateEnd);
    const categoryIndex = dateSection.indexOf(`${categoryHeading}\n`);
    if (categoryIndex !== -1) {
      const afterHeading = dateIndex + categoryIndex + categoryHeading.length + 1;
      edgeSection =
        edgeSection.slice(0, afterHeading) + `\n${bullet}` + edgeSection.slice(afterHeading);
    } else {
      const insertAt = CATEGORIES.slice(0, CATEGORIES.indexOf(note.category))
        .map((category) => dateSection.indexOf(`#### ${category}\n`))
        .filter((index) => index !== -1)
        .reduce((furthest, index) => {
          const nextHeading = dateSection.indexOf("\n#### ", index + 1);
          return Math.max(furthest, nextHeading === -1 ? dateSection.length : nextHeading + 1);
        }, dateSection.length);
      const absoluteInsertAt = dateIndex + insertAt;
      const before = edgeSection.slice(0, absoluteInsertAt).replace(/\n+$/, "\n");
      const after = edgeSection.slice(absoluteInsertAt);
      edgeSection = `${before}\n${categoryHeading}\n\n${bullet}\n` + after.replace(/^\n+/, "\n");
    }
  } else {
    const firstDate = edgeSection.match(/^### (\d{4}-\d{2}-\d{2})$/m);
    const insertAt = firstDate && firstDate[1] < today ? firstDate.index : edgeSection.length;
    const before = edgeSection.slice(0, insertAt).replace(/\n+$/, "\n");
    const after = edgeSection.slice(insertAt).replace(/^\n+/, "\n");
    edgeSection = `${before}\n${dateHeading}\n\n${categoryHeading}\n\n${bullet}\n\n` + after;
  }

  return markdown.slice(0, edgeStart) + edgeSection + markdown.slice(edgeEnd);
}

function selfTest() {
  assert.equal(parseReleaseNote(""), null);
  assert.equal(parseReleaseNote("## Release note\nCategory: N/A\n"), null);
  assert.equal(parseReleaseNote("## Release note\nCategory: Fixed\nTitle: X\n"), null);

  const note = parseReleaseNote(
    "## Summary\nstuff\n\n## Release note\nCategory: Fixed\nTitle: Thing broke.\nDescription: It works now.\n"
  );
  assert.deepEqual(note, { category: "Fixed", title: "Thing broke", description: "It works now." });

  const firstEntry = appendReleaseNote(
    "# What's New in Moss\n\n## Edge channel\n\nEdge builds.\n",
    { category: "Added", title: "First entry", description: "The first note for this date." },
    { prNumber: 41, prUrl: "https://example.com/41", today: "2026-08-20" }
  );
  assert.match(firstEntry, /## Edge channel\n[\s\S]*### 2026-08-20\n\n#### Added\n/);

  const doc = [
    "# What's New in Moss",
    "",
    "## Edge channel — 2026-08-14",
    "",
    "intro line",
    "",
    "### Added",
    "",
    "- **Old thing.** Existing entry. [PR #1](url)",
    "",
    "### Fixed",
    "",
    "- **Old fix.** Existing entry. [PR #2](url)",
    "",
    "## v0.1.16 — 2026-08-05",
    "",
    "### Added",
    "",
    "- **Older still.** [PR #3](url)",
    ""
  ].join("\n");

  const withFix = appendReleaseNote(
    doc,
    { category: "Fixed", title: "New fix", description: "Broken thing now works." },
    { prNumber: 42, prUrl: "https://example.com/42", today: "2026-08-20" }
  );
  assert.match(withFix, /## Edge channel\n/);
  assert.match(withFix, /### 2026-08-20\n\n#### Fixed\n\n- \*\*New fix\.\*\*/);
  assert.match(withFix, /### 2026-08-14[\s\S]*#### Fixed\n\n- \*\*Old fix\.\*\*/);
  assert.doesNotMatch(withFix.slice(withFix.indexOf("## v0.1.16")), /New fix/);

  const withChanged = appendReleaseNote(
    withFix,
    { category: "Changed", title: "New behavior", description: "It behaves differently now." },
    { prNumber: 43, prUrl: "https://example.com/43", today: "2026-08-20" }
  );
  assert.match(
    withChanged,
    /### 2026-08-20\n\n#### Fixed\n[\s\S]*#### Changed\n\n- \*\*New behavior\./
  );
  assert.equal((withChanged.match(/### 2026-08-20\n/g) ?? []).length, 1);

  const withLaterDate = appendReleaseNote(
    withChanged,
    { category: "Added", title: "Later release", description: "A later release note." },
    { prNumber: 44, prUrl: "https://example.com/44", today: "2026-08-21" }
  );
  assert.match(withLaterDate, /### 2026-08-21\n\n#### Added\n\n- \*\*Later release/);
  assert.match(withLaterDate, /### 2026-08-20[\s\S]*New behavior/);
  assert.equal((withLaterDate.match(/### 2026-08-20\n/g) ?? []).length, 1);

  const duplicate = appendReleaseNote(
    withLaterDate,
    { category: "Fixed", title: "New fix", description: "Broken thing now works." },
    { prNumber: 44, prUrl: "https://example.com/44", today: "2026-08-21" }
  );
  assert.equal(duplicate, withLaterDate);

  const concurrentInputs = appendReleaseNote(
    appendReleaseNote(
      doc,
      { category: "Added", title: "First queued", description: "First queued note." },
      { prNumber: 45, prUrl: "https://example.com/45", today: "2026-08-22" }
    ),
    { category: "Fixed", title: "Second queued", description: "Second queued note." },
    { prNumber: 46, prUrl: "https://example.com/46", today: "2026-08-22" }
  );
  assert.match(concurrentInputs, /\[PR #45\]/);
  assert.match(concurrentInputs, /\[PR #46\]/);

  console.log("append-release-note self-test passed");
}

function readPullRequest(number) {
  const raw = execFileSync(
    "gh",
    ["api", `repos/{owner}/{repo}/pulls/${number}`, "--jq", "{body, number, url: .html_url}"],
    { encoding: "utf8" }
  );
  const pullRequest = JSON.parse(raw);
  assert.ok(pullRequest.number, `gh returned no pull request for #${number}`);
  return pullRequest;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  // `--pr N` is the everyday path: read the pull request straight from GitHub rather than making
  // the caller marshal three values by hand. The explicit flags stay for tests and for anyone
  // without gh on PATH.
  const fetched = argument("--pr") ? readPullRequest(argument("--pr")) : null;

  const body = fetched?.body ?? argument("--body") ?? process.env.PR_BODY ?? "";
  const prNumber = fetched?.number ?? argument("--pr-number") ?? process.env.PR_NUMBER;
  const prUrl = fetched?.url ?? argument("--pr-url") ?? process.env.PR_URL;
  assert.ok(prNumber, "missing --pr / --pr-number / PR_NUMBER");
  assert.ok(prUrl, "missing --pr / --pr-url / PR_URL");

  const note = parseReleaseNote(body);
  if (!note) {
    console.log("No usable release note on this pull request — nothing to append.");
    return;
  }

  const markdown = await readFile(WHATS_NEW_PATH, "utf8");
  const updated = appendReleaseNote(markdown, note, { prNumber, prUrl, today: todayPacificDate() });
  await writeFile(WHATS_NEW_PATH, updated);
  console.log(`Appended ${note.category} release note for PR #${prNumber} to docs/WHATS_NEW.md`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
