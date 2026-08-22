#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PACIFIC = "America/Los_Angeles";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CATEGORIES = ["Feature", "Fix", "Docs", "Test", "Revert", "Other"];
const FAILURE_STATES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "STARTUP_FAILURE",
  "TIMED_OUT"
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function categoryFor(title) {
  if (/^feat(?:\b|[:(])/i.test(title) || /^Settings Host and Account Truth\b/i.test(title))
    return "Feature";
  if (/^fix(?:\b|[:(])/i.test(title)) return "Fix";
  if (/^test(?:\b|[:(])/i.test(title)) return "Test";
  if (/^docs?(?:\b|[:(])/i.test(title)) return "Docs";
  if (/^revert\b/i.test(title)) return "Revert";
  return "Other";
}

function checkState(check) {
  return String(check.conclusion || check.state || check.status || "").toUpperCase();
}

export function statusFor(pullRequest) {
  if (pullRequest.isDraft) return "draft";
  const checks = pullRequest.statusCheckRollup ?? [];
  if (checks.some((check) => FAILURE_STATES.has(checkState(check)))) return "blocked";
  if (
    checks.some((check) => {
      const state = checkState(check);
      return state === "IN_PROGRESS" || state === "PENDING" || state === "QUEUED";
    })
  ) {
    return "validating";
  }
  return checks.length > 0 ? "ready" : "open";
}

function dateParts(date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: PACIFIC,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
}

function pacificDateKey(date) {
  const { year, month, day } = dateParts(date);
  return `${year}-${month}-${day}`;
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function displayDate(date, options = {}) {
  return new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC, ...options }).format(date);
}

function weeklyStart(end, value) {
  const start = new Date(value ?? end.getTime() - WEEK_MS);
  assert.ok(Number.isFinite(start.getTime()), "Invalid report date");
  assert.equal(end.getTime() - start.getTime(), WEEK_MS, "Report window must be exactly 168 hours");
  return start;
}

function ghJson(args) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(output);
}

function loadPullRequests(repo, start, end) {
  const merged = ghJson([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--search",
    `merged:>=${utcDateKey(start)}`,
    "--limit",
    "300",
    "--json",
    "number,title,url,mergedAt,mergeCommit"
  ])
    .filter((pullRequest) => {
      const mergedAt = new Date(pullRequest.mergedAt);
      return mergedAt >= start && mergedAt < end;
    })
    .sort((left, right) => new Date(left.mergedAt) - new Date(right.mergedAt));

  const open = ghJson([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,url,isDraft,headRefOid,mergeStateStatus,statusCheckRollup"
  ]).sort((left, right) => left.number - right.number);

  return { merged, open };
}

function checkSummary(pullRequest) {
  const checks = pullRequest.statusCheckRollup ?? [];
  const failed = checks.filter((check) => FAILURE_STATES.has(checkState(check)));
  if (failed.length > 0) {
    return `Blocking checks: ${failed.map((check) => check.name || check.context).join(", ")}.`;
  }
  const running = checks.filter((check) => {
    const state = checkState(check);
    return state === "IN_PROGRESS" || state === "PENDING" || state === "QUEUED";
  });
  if (running.length > 0) {
    return `Running checks: ${running.map((check) => check.name || check.context).join(", ")}.`;
  }
  if (checks.length > 0) return "All reported checks passed; the pull request remains open.";
  return "No required check result is reported yet.";
}

function renderOpen(pullRequests) {
  if (pullRequests.length === 0) return '<p class="empty">No open pull requests.</p>';
  return pullRequests
    .map((pullRequest) => {
      const status = statusFor(pullRequest);
      const head = pullRequest.headRefOid ? pullRequest.headRefOid.slice(0, 8) : "—";
      return `<article class="open-row">
        <div class="open-id">#${pullRequest.number}</div>
        <div>
          <span class="status status--${status}">${status}</span>
          <h3 class="open-title"><a href="${escapeHtml(pullRequest.url)}">${escapeHtml(pullRequest.title)}</a></h3>
        </div>
        <p class="open-note"><strong>Head ${head}.</strong> ${escapeHtml(checkSummary(pullRequest))}</p>
      </article>`;
    })
    .join("\n");
}

function renderLedger(pullRequests) {
  if (pullRequests.length === 0)
    return '<p class="empty">No pull requests merged in this window.</p>';
  const groups = Map.groupBy(pullRequests, (pullRequest) =>
    utcDateKey(new Date(pullRequest.mergedAt))
  );
  return [...groups.entries()]
    .map(([key, entries]) => {
      const label = displayDate(new Date(entries[0].mergedAt), {
        timeZone: "UTC",
        weekday: "short",
        month: "short",
        day: "numeric"
      });
      const items = entries
        .map(
          (pullRequest) => `<li class="entry">
            <span class="meta">PR ${pullRequest.number}</span>
            <span class="entry-title"><a href="${escapeHtml(pullRequest.url)}">${escapeHtml(pullRequest.title)}</a></span>
            <span class="kind">${categoryFor(pullRequest.title)}</span>
          </li>`
        )
        .join("\n");
      return `<section class="day" data-date="${key}">
        <h3>${escapeHtml(label)}</h3>
        <ol class="entries">${items}</ol>
      </section>`;
    })
    .join("\n");
}

function renderReport({ repo, start, end, merged, open, stylesheet }) {
  const counts = Map.groupBy(merged, (pullRequest) => categoryFor(pullRequest.title));
  const featureCount = counts.get("Feature")?.length ?? 0;
  const fixCount = counts.get("Fix")?.length ?? 0;
  const categoryStats = CATEGORIES.map(
    (category) =>
      `<div class="stat"><span class="stat-number">${counts.get(category)?.length ?? 0}</span><span class="stat-label">${category} PRs</span></div>`
  ).join("\n        ");
  const startLabel = displayDate(start, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  const endLabel = displayDate(end, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  const generatedLabel = displayDate(end, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Moss weekly release record: ${merged.length} merged pull requests and ${open.length} open lanes." />
    <title>Moss Weekly · ${escapeHtml(endLabel)}</title>
    <link rel="stylesheet" href="${escapeHtml(stylesheet)}" />
  </head>
  <body>
    <header class="masthead">
      <p class="issue">Release record · UTC window ${escapeHtml(startLabel)} to ${escapeHtml(endLabel)}</p>
      <p class="wordmark">MOSS WEEKLY</p>
      <nav class="nav" aria-label="Release sections">
        <a href="#summary">The short version</a><a href="#open">Open lanes</a><a href="#ledger">Full ledger</a><a href="https://github.com/${escapeHtml(repo)}">Source</a>
      </nav>
    </header>
    <main>
      <section class="hero" aria-labelledby="release-title">
        <div>
          <p class="kicker">Weekly delivery record</p>
          <h1 id="release-title">What reached main this week.</h1>
          <p class="lede">Every merged pull request is counted from GitHub. Open work is listed separately with its current check state.</p>
        </div>
        <p class="snapshot">This is a generated delivery snapshot. “Merged” means present on main. Open, validating, ready, and blocked work is excluded from the shipped count.</p>
      </section>
      <section class="open" id="summary" aria-labelledby="summary-title">
        <p class="kicker">In plain English</p>
        <h2 class="section-title" id="summary-title">A week of making Moss more useful.</h2>
        <p class="section-intro">This week Moss shipped ${featureCount} feature PR${featureCount === 1 ? "" : "s"}, smoothed ${fixCount} rough edge${fixCount === 1 ? "" : "s"}, and kept the rest of the house in shape. The full ledger below is the source of record, with every merged pull request counted exactly once.</p>
      </section>
      <section class="stats" aria-label="Release totals">
        <div class="stat"><span class="stat-number">${merged.length}</span><span class="stat-label">Merged PRs</span></div>
        ${categoryStats}
        <div class="stat"><span class="stat-number">${open.length}</span><span class="stat-label">Open lanes</span></div>
      </section>
      <section class="open" id="open" aria-labelledby="open-title">
        <p class="kicker">Not in the shipped count</p>
        <h2 class="section-title" id="open-title">Open lanes, plainly tagged.</h2>
        <p class="section-intro">Drafts, running checks, failures, and merge-ready work remain here until GitHub records a merge.</p>
        ${renderOpen(open)}
      </section>
      <section class="ledger" id="ledger" aria-labelledby="ledger-title">
        <p class="kicker">Source of record</p>
        <h2 class="section-title" id="ledger-title">Every merged pull request.</h2>
        <p class="section-intro">Ordered by merge time and grouped by UTC date. Titles link directly to GitHub.</p>
        ${renderLedger(merged)}
      </section>
    </main>
    <footer class="colophon"><p>MOSS WEEKLY · WINDOW ${escapeHtml(start.toISOString())} TO ${escapeHtml(end.toISOString())} · GENERATED ${escapeHtml(generatedLabel)} · SOURCE <a href="https://github.com/${escapeHtml(repo)}/pulls">GITHUB PULL REQUESTS</a></p></footer>
  </body>
</html>\n`;
}

function renderLatestRedirect(reportDate, prefix = "") {
  const destination = `${prefix}${reportDate}-weekly/`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${destination}" />
    <title>Moss Weekly</title>
  </head>
  <body><p><a href="${destination}">Open the latest Moss weekly release report</a></p></body>
</html>\n`;
}

function selfTest() {
  assert.equal(escapeHtml('<a title="x">&</a>'), "&lt;a title=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(categoryFor("feat(web): ship it"), "Feature");
  assert.equal(categoryFor("Settings Host and Account Truth — Slice 1"), "Feature");
  assert.equal(categoryFor("Revert unsafe change"), "Revert");
  const end = new Date("2026-07-17T21:26:16.000Z");
  assert.equal(weeklyStart(end).toISOString(), "2026-07-10T21:26:16.000Z");
  assert.throws(() => weeklyStart(end, "2026-07-12"), /exactly 168 hours/);
  const report = renderReport({
    repo: "motioneso/Jarv1s",
    start: weeklyStart(end),
    end,
    merged: ["feat: one", "fix: one", "docs: one", "test: one", "Revert one", "chore: one"].map(
      (title, index) => ({
        number: index + 1,
        title,
        url: `https://example.com/${index + 1}`,
        mergedAt: end.toISOString()
      })
    ),
    open: [],
    stylesheet: "../weekly-release.css"
  });
  for (const category of CATEGORIES) {
    assert.match(report, new RegExp(`>1</span><span class="stat-label">${category} PRs</span>`));
  }
  assert.equal(statusFor({ isDraft: true, statusCheckRollup: [] }), "draft");
  assert.equal(
    statusFor({ isDraft: false, statusCheckRollup: [{ conclusion: "FAILURE" }] }),
    "blocked"
  );
  assert.equal(
    statusFor({ isDraft: false, statusCheckRollup: [{ status: "IN_PROGRESS" }] }),
    "validating"
  );
  assert.equal(
    statusFor({ isDraft: false, statusCheckRollup: [{ conclusion: "SUCCESS" }] }),
    "ready"
  );
  console.log("weekly-release self-test passed");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const repo = argument("--repo") ?? process.env.GITHUB_REPOSITORY ?? "motioneso/Jarv1s";
  const end = new Date(argument("--end") ?? Date.now());
  assert.ok(Number.isFinite(end.getTime()), "Invalid report date");
  const start = weeklyStart(end, argument("--start"));

  const outputRoot = path.resolve(argument("--output") ?? "docs/releases");
  const reportDate = argument("--report-date") ?? pacificDateKey(end);
  const archiveDirectory = path.join(outputRoot, `${reportDate}-weekly`);
  const { merged, open } = loadPullRequests(repo, start, end);
  await mkdir(archiveDirectory, { recursive: true });
  await writeFile(
    path.join(archiveDirectory, "index.html"),
    renderReport({ repo, start, end, merged, open, stylesheet: "../weekly-release.css" })
  );
  const latestRedirect = renderLatestRedirect(reportDate);
  await writeFile(path.join(outputRoot, "index.html"), latestRedirect);
  await mkdir(path.join(outputRoot, "weekly"), { recursive: true });
  await writeFile(
    path.join(outputRoot, "weekly", "index.html"),
    renderLatestRedirect(reportDate, "../")
  );
  console.log(
    `Generated ${reportDate}: ${merged.length} merged, ${open.length} open → ${archiveDirectory}`
  );
}

await main();
