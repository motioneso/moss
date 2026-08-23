#!/usr/bin/env node
// Pulls the "Release note" section out of a pull request body and appends it to
// docs/WHATS_NEW.md's edge-channel section. Silently does nothing when a pull request has no
// release note (internal/non-user-facing change) — that is the normal case, not an error.
//
// Run by hand from the pull request's own branch, once the pull request exists and has a number:
//
//   node scripts/append-release-note.mjs --pr 1796
//
// then commit docs/WHATS_NEW.md onto that same branch. This used to run as a GitHub Action on
// merge, which pushed straight to main; the "Require CI gate on main" ruleset rejects such a push
// because a direct push has no pull request and therefore no CI gate run to satisfy the required
// check. Nothing the bot pushes can pass that rule without a bypass credential, so the note is now
// written where every other change is written — in the pull request. See #1795.
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

/** Inserts the new bullet under the edge channel's category heading, creating the heading
 * (in canonical Added/Fixed/Changed order) if this is the first entry of that category. */
export function appendReleaseNote(markdown, note, { prNumber, prUrl, today }) {
  const bullet = `- **${note.title}.** ${note.description} [PR #${prNumber}](${prUrl})`;

  const edgeMatch = markdown.match(/^## Edge channel — \S+\n/m);
  assert.ok(edgeMatch, "docs/WHATS_NEW.md is missing its '## Edge channel' heading");
  const edgeStart = edgeMatch.index;
  const nextTopHeadingIndex = markdown.indexOf("\n## ", edgeStart + edgeMatch[0].length);
  const edgeEnd = nextTopHeadingIndex === -1 ? markdown.length : nextTopHeadingIndex + 1;

  let edgeSection = markdown
    .slice(edgeStart, edgeEnd)
    .replace(/^## Edge channel — \S+/, `## Edge channel — ${today}`);

  const categoryHeading = `### ${note.category}`;
  const categoryIndex = edgeSection.indexOf(`${categoryHeading}\n`);
  if (categoryIndex === -1) {
    const insertAt = CATEGORIES.slice(0, CATEGORIES.indexOf(note.category))
      .map((category) => edgeSection.indexOf(`### ${category}\n`))
      .filter((index) => index !== -1)
      .reduce((furthest, index) => {
        const nextHeading = edgeSection.indexOf("\n### ", index + 1);
        const sectionEnd = nextHeading === -1 ? edgeSection.length : nextHeading + 1;
        return Math.max(furthest, sectionEnd);
      }, edgeSection.length);
    // Normalise the blank lines either side of the new section rather than only prepending one.
    // When the new section lands at the very end of the edge channel, what follows it is the next
    // top-level heading, which lives outside this slice — so without the trailing newline the new
    // bullet ran straight into "## v0.1.16" with no blank line between them, and the whitespace
    // already at the end of the slice produced a doubled blank line above the heading.
    const before = edgeSection.slice(0, insertAt).replace(/\n+$/, "\n");
    const after = edgeSection.slice(insertAt);
    edgeSection =
      `${before}\n${categoryHeading}\n\n${bullet}\n` + (after.startsWith("\n") ? "" : "\n") + after;
  } else {
    const afterHeading = categoryIndex + categoryHeading.length + 1;
    edgeSection =
      edgeSection.slice(0, afterHeading) + "\n" + bullet + edgeSection.slice(afterHeading);
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
  assert.match(withFix, /## Edge channel — 2026-08-20/);
  assert.match(
    withFix,
    /### Fixed\n\n- \*\*New fix\.\*\* Broken thing now works\. \[PR #42\]\(https:\/\/example\.com\/42\)\n- \*\*Old fix\.\*\*/
  );
  assert.doesNotMatch(withFix.slice(withFix.indexOf("## v0.1.16")), /New fix/);

  const withChanged = appendReleaseNote(
    doc,
    { category: "Changed", title: "New behavior", description: "It behaves differently now." },
    { prNumber: 43, prUrl: "https://example.com/43", today: "2026-08-20" }
  );
  assert.match(withChanged, /### Changed\n\n- \*\*New behavior\.\*\* It behaves differently now\./);
  assert.ok(withChanged.indexOf("### Changed") > withChanged.indexOf("### Fixed"));
  assert.ok(withChanged.indexOf("### Changed") < withChanged.indexOf("## v0.1.16"));
  // A new section at the end of the edge channel butts up against the next top-level heading,
  // which is outside the slice being edited. Exactly one blank line either side of it, or the
  // file fails `prettier --check` and the bullet reads as part of the older release below it.
  assert.match(
    withChanged,
    /- \*\*Old fix\.\*\* Existing entry\. \[PR #2\]\(url\)\n\n### Changed\n\n- \*\*New behavior\.\*\*[^\n]*\n\n## v0\.1\.16/
  );

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

// Only run when invoked directly; the weekly digest imports parseReleaseNote from here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
