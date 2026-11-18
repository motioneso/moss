/* global document, navigator, crypto, setTimeout, clearTimeout */
import { moduleClient } from "./guest-bridge.mjs";
import { briefingsApi } from "./api.mjs";
import {
  EVENING_SECTION_NAMES,
  delayedEmail,
  findDefinition,
  monthDay,
  parseFreshness,
  preparedAt,
  readEditorial,
  replyPrompt,
  splitHeadline,
  staleNames,
  targetTimeFor,
  timeText
} from "./view.mjs";
import {
  actionRowsHtml,
  catchUpHtml,
  earlierHtml,
  esc,
  newsBlock,
  renderMarkdown,
  sourcesHtml,
  sportsBlock
} from "./parts.mjs";

const client = moduleClient();
const api = briefingsApi(client);
const root = document.getElementById("root");
const locale = navigator.language || undefined;

const state = {
  phase: "loading",
  kind: "morning",
  definitions: [],
  runs: [],
  detail: null,
  selectedRunId: null,
  expanded: false,
  retrying: false,
  retryError: false
};

let pollTimer = null;

function reportHtml(detail, evening) {
  const run = detail.run;
  const now = Date.now();
  const meta = run.sourceMetadata ?? {};
  const head = splitHeadline(run.summaryText ?? "");
  const freshness = parseFreshness(meta);
  const delayed = delayedEmail(freshness);
  const stale = freshness ? staleNames(freshness, delayed ? ["email"] : []) : [];
  const news = readEditorial(meta, "news");
  const sports = readEditorial(meta, "sports");
  const payload = run.structuredPayload ?? {};
  return `
    ${detail.latest ? "" : `<p class="brief-reader__dated">Report from ${esc(monthDay(run.createdAt, locale))}.</p>`}
    <p class="brief-reader__prepared">${esc(preparedAt(run.createdAt, locale))}</p>
    ${head.headline ? `<h3 class="brief-reader__headline">${esc(head.headline)}</h3>` : ""}
    ${head.rest ? renderMarkdown(head.rest, evening ? EVENING_SECTION_NAMES : []) : ""}
    ${
      detail.plan?.status === "changed"
        ? `<div class="brief-reader__callout"><p class="brief-reader__callout-kicker">Changed overnight</p><p class="brief-reader__plan-changed">The plan has changed since this report.</p></div>`
        : ""
    }
    ${
      delayed
        ? `<div class="brief-reader__email-delay" role="note"><p><strong>Email hasn’t updated since <time datetime="${esc(delayed.asOf)}">${esc(monthDay(delayed.asOf, locale))} at ${esc(timeText(delayed.asOf, locale))}</time>.</strong></p><p>There may be newer replies this briefing hasn’t seen. Calendar and task details remain available.</p></div>`
        : ""
    }
    ${stale.length ? `<p class="brief-reader__stale" role="note">Some sources are more than a day old: ${esc(stale.join(", "))}.</p>` : ""}
    ${actionRowsHtml(payload.actionRows, now, locale)}
    ${catchUpHtml(payload.catchUp, now, locale, state.expanded)}
    ${newsBlock(news)}
    ${sportsBlock(sports, locale)}
    ${sourcesHtml(freshness, meta, now)}
    ${earlierHtml(state.runs, state.selectedRunId, locale)}`;
}

function bodyHtml() {
  const evening = state.kind === "evening";
  const name = evening ? "evening briefing" : "morning briefing";
  const definition = findDefinition(state.definitions, state.kind);
  if (!definition) {
    return `<p class="cmd-empty" role="status">You have no ${name} set up yet. Turn it on in Briefings settings from the cog in the header.</p>`;
  }
  const d = state.detail;
  if (!d && state.runs.length === 0) {
    return `<p class="cmd-empty" role="status">No ${name} has been prepared yet.</p>`;
  }
  if (d?.state === "ready" && d.run && d.run.status === "succeeded") return reportHtml(d, evening);
  const failed = state.phase === "failed" || d?.state === "failed" || d?.state === "ready";
  return `<div><p class="cmd-empty" role="status">${failed ? `Your ${name} isn't available.` : `Your ${name} is being prepared.`}</p>
    ${state.retryError ? `<p class="brief-reader__retry-error" role="status">The retry request couldn’t be confirmed. Try again.</p>` : ""}
    ${failed ? `<button type="button" class="jds-btn" id="retry" ${state.retrying ? "disabled" : ""}>Try again</button>` : ""}</div>`;
}

function render() {
  const evening = state.kind === "evening";
  if (state.phase === "loading") {
    root.innerHTML = `<p class="cmd-empty" role="status" aria-busy="true">Loading your briefing…</p>`;
    return;
  }
  if (state.phase === "error") {
    root.innerHTML = `<p class="cmd-empty" role="status">Your briefing couldn't load.</p><button type="button" class="jds-btn" id="retry-load">Try again</button>`;
    document.getElementById("retry-load").onclick = load;
    return;
  }
  const definition = findDefinition(state.definitions, state.kind);
  const run = state.detail?.run;
  const railDate = new Date(run?.createdAt ?? Date.now()).toLocaleDateString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
  const tab = (kind, label) =>
    `<button type="button" role="tab" class="brief-reader__tab${state.kind === kind ? " brief-reader__tab--selected" : ""}" aria-selected="${state.kind === kind}" data-kind="${kind}">${label}</button>`;
  root.innerHTML = `
  <div class="brief-reader brief-reader--report">
  <header class="brief-reader__head">
    <div class="brief-reader__eyebrow">${evening ? "Moss / Evening briefing" : "Moss / Morning briefing"}</div>
    <h2 class="brief-reader__title">${evening ? "Your day, reviewed." : "Your day, prepared."}</h2>
    <div class="brief-reader__tablist" role="tablist" aria-label="Briefings">${tab("morning", "Morning")}${tab("evening", "Evening")}</div>
  </header>
  <div class="brief-reader__grid">
    <div class="brief-reader__report" role="tabpanel" data-briefing-surface="${evening ? "evening-read" : "automatic-read"}">${bodyHtml()}</div>
    <aside class="brief-reader__railwrap"><div class="brief-reader__rail">
      <p class="brief-reader__rail-date">${esc(railDate)}</p>
      <h3 class="brief-reader__rail-heading">Your schedule</h3>
      <p class="brief-reader__rail-line">${
        definition
          ? definition.enabled
            ? `Prepared daily around ${esc(targetTimeFor(definition, state.kind))}.`
            : "This briefing is turned off."
          : "Not set up yet."
      }</p>
    </div></aside>
  </div>
  <footer class="brief-reader__footer"><div class="brief-reader__footer-back"><button type="button" class="jds-btn jds-btn--quiet" data-go="/">Back to Today</button></div></footer>
  </div>`;
  wire();
  client.resize?.(document.documentElement.scrollHeight).catch?.(() => {});
}

function wire() {
  for (const b of root.querySelectorAll("[data-kind]"))
    b.onclick = () => switchKind(b.dataset.kind);
  for (const b of root.querySelectorAll("[data-go]")) {
    b.onclick = () => client.navigate(b.dataset.go).catch(() => {});
  }
  for (const b of root.querySelectorAll("[data-reply]")) {
    b.onclick = () => client.chat(replyPrompt(b.dataset.reply)).catch(() => {});
  }
  for (const b of root.querySelectorAll("[data-run]")) b.onclick = () => openRun(b.dataset.run);
  const more = document.getElementById("catchup-more");
  if (more) {
    more.onclick = () => {
      state.expanded = true;
      render();
    };
  }
  const retry = document.getElementById("retry");
  if (retry) retry.onclick = retryRun;
}

function stopPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

async function openRun(runId, jobId) {
  stopPoll();
  const definition = findDefinition(state.definitions, state.kind);
  state.selectedRunId = runId;
  state.phase = "ready";
  try {
    state.detail = await api.run(definition.id, runId, jobId);
    if (state.detail.state !== "ready" && state.detail.state !== "failed") {
      pollTimer = setTimeout(() => openRun(runId, jobId), 1000);
    }
  } catch {
    state.detail = null;
    state.phase = "failed";
  }
  render();
}

async function loadKind() {
  stopPoll();
  state.detail = null;
  state.runs = [];
  state.selectedRunId = null;
  state.retryError = false;
  state.phase = "ready";
  const definition = findDefinition(state.definitions, state.kind);
  if (!definition) return render();
  try {
    const found = await api.runs(definition.id);
    state.runs = found.runs ?? [];
  } catch {
    state.phase = "error";
    return render();
  }
  const latest = state.runs.find((r) => r.status === "succeeded") ?? state.runs[0];
  if (latest) await openRun(latest.id);
  else render();
}

async function switchKind(kind) {
  if (kind === state.kind) return;
  state.kind = kind;
  render();
  await loadKind();
}

async function retryRun() {
  const definition = findDefinition(state.definitions, state.kind);
  if (!definition || state.retrying) return;
  state.retrying = true;
  state.retryError = false;
  render();
  try {
    const started = await api.start(definition.id, crypto.randomUUID());
    state.retrying = false;
    state.phase = "ready";
    await openRun(started.runId, started.jobId);
    return;
  } catch {
    state.retryError = true;
  }
  state.retrying = false;
  render();
}

async function load() {
  state.phase = "loading";
  render();
  try {
    const data = await api.definitions();
    state.definitions = data.definitions ?? [];
  } catch {
    state.phase = "error";
    return render();
  }
  await loadKind();
}

load();
