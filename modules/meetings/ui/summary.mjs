import {
  accessDenied,
  esc,
  exportStatus,
  markdownBody,
  operationError,
  randomKey,
  resolveSummary,
  SELF_CONTAINED,
  summaryFailure
} from "./format.mjs";
import { btn, eyebrow, field, hint, note, sectionHead, select, status } from "./kit.mjs";
import { artifactContent, candidateHtml, copyHtml, editorHtml, vaultHtml } from "./summary-parts.mjs";

const POLL_MS = 3000;
const DENIED = "Summary access is unavailable. Return to history or sign in again.";
const TOOL_TITLE = {
  rewrite: "Rewrite summary",
  versions: "Earlier versions",
  vault: "Save to vault",
  copy: "Copy as Markdown"
};

/** Summary pane: outputs, rewrite, versions, editor, suggested tasks, vault save and copy. */
export function summaryPane(ctx, ws) {
  const { api, draw, focus } = ctx;
  let timer = null;
  let s = fresh();

  function fresh() {
    return {
      selected: undefined,
      pinned: undefined,
      editing: false,
      compare: false,
      templateId: "",
      gen: null,
      generated: undefined,
      edits: {},
      cands: {},
      sources: {},
      vault: { receipt: null, receipts: { state: "loading", list: [] }, op: null },
      vaultFor: null,
      copyStatus: "",
      fetching: false,
      autoTitleKey: null
    };
  }

  const out = () => ws.outputs;
  const head = () => out().data?.headVersion ?? 0;
  const stillHere = (id) => ws.id === id;

  /* ---------- loading ---------- */

  async function load() {
    const id = ws.id;
    clearTimeout(timer);
    s.fetching = true;
    if (!out().data) out().phase = "loading";
    draw();
    try {
      const data = await api.outputs(id);
      if (!stillHere(id)) return;
      ws.outputs = { phase: "ready", data };
      s.fetching = false;
      const auto = data.automaticSummary;
      if (auto?.status === "saved" && s.autoTitleKey !== `${id}:${auto.requestKey}`) {
        s.autoTitleKey = `${id}:${auto.requestKey}`;
        ctx.refreshRecord?.();
      }
      ensureSources();
      if (auto && (auto.status === "waiting" || auto.status === "pending"))
        timer = setTimeout(() => stillHere(id) && void load(), POLL_MS);
    } catch (error) {
      if (!stillHere(id)) return;
      s.fetching = false;
      if (accessDenied(error)) ws.outputs = { phase: "denied", data: null };
      else if (!out().data) ws.outputs = { phase: "failed", data: null };
      else ws.outputs = { ...out(), phase: "ready", refreshFailed: true };
    }
    draw();
  }

  function start() {
    clearTimeout(timer);
    s = fresh();
    void load();
  }

  function openTool() {
    if (ws.tool === "vault") void loadReceipts();
    if (ws.tool === "rewrite" && !s.templateId) s.templateId = "";
  }

  /* ---------- current artifact ---------- */

  function current() {
    const data = out().data;
    if (!data) return {};
    const artifact =
      data.artifacts.find((a) => a.version === (s.selected ?? data.headVersion)) ??
      (s.selected === s.pinned?.version ? s.pinned : undefined);
    const latest = data.artifacts.find((a) => a.version === data.headVersion);
    return { data, artifact, latest };
  }

  function availability() {
    if (s.fetching) return "checking";
    if (out().phase === "failed" || out().refreshFailed) return "check-failed";
    return out().data?.generationAvailability ?? "check-failed";
  }

  function recordingType() {
    const rec = ws.type.data;
    return rec?.configuration.types.find((t) => t.id === rec.metadata?.typeId);
  }

  function baseline(artifact) {
    return resolveSummary(artifact.content);
  }

  function edit(artifact) {
    return (s.edits[artifact.version] ??= { content: baseline(artifact), op: null });
  }

  function dirty(artifact) {
    const e = edit(artifact);
    return (
      JSON.stringify(e.content) !==
      JSON.stringify(e.op?.status === "done" ? e.op.input.content : baseline(artifact))
    );
  }

  function keptEdits(artifact) {
    const e = s.edits[artifact.version];
    return (
      !!e &&
      JSON.stringify(e.content) !==
        JSON.stringify(e.op?.status === "done" ? e.op.input.content : baseline(artifact))
    );
  }

  /* ---------- sources for suggested tasks ---------- */

  function candidateShown(candidate, artifact, data) {
    return (
      candidate.artifactVersion === artifact.version ||
      candidate.reviewState === "accepted" ||
      resolveSummary(artifact.content).actions.some(
        (a) => JSON.stringify(a) === JSON.stringify(candidate.proposal)
      )
    );
  }

  function ensureSources() {
    const { data } = current();
    if (!data) return;
    for (const c of data.candidates) {
      const have = data.artifacts.some((a) => a.version === c.artifactVersion);
      if (!have && !s.sources[c.artifactVersion]) void loadSource(c.artifactVersion);
    }
  }

  async function loadSource(version) {
    const id = ws.id;
    s.sources[version] = { state: "loading" };
    draw();
    try {
      const reply = await api.output(id, version);
      if (!stillHere(id)) return;
      s.sources[version] = { state: "ready", artifact: reply.artifact };
    } catch (error) {
      if (!stillHere(id)) return;
      if (accessDenied(error)) ws.outputs = { phase: "denied", data: null };
      s.sources[version] = { state: "failed" };
    }
    draw();
  }

  const cand = (candidate) =>
    (s.cands[candidate.id] ??= { title: candidate.proposal.text, op: null, result: null });

  /* ---------- writes ---------- */

  async function generate() {
    const { data } = current();
    const op = s.gen;
    const retry = op?.status === "retry" || op?.status === "pending";
    if (op?.status === "running" || !data) return;
    const type = recordingType();
    const template = data.templates.find((t) => t.id === (type?.templateId ?? s.templateId));
    if (!retry && (availability() !== "available" || !template)) return;
    const id = ws.id;
    const input = retry
      ? op.input
      : {
          requestKey: randomKey(),
          expectedOutputVersion: data.headVersion,
          expectedTranscriptRevision: ws.transcript.data?.snapshot.transcriptRevision ?? 0,
          expectedNotesRevision: ws.meeting.notesRevision,
          templateId: template.id,
          templateVersion: template.version
        };
    s.generated = undefined;
    s.gen = { input, status: "running", message: "Writing summary…" };
    draw();
    const mine = () => stillHere(id) && s.gen?.input.requestKey === input.requestKey;
    try {
      const result = await api.generate(id, input);
      if (!mine()) return;
      const preserve = !!s.pinned && keptEdits(s.pinned);
      if (result.status === "saved" && !preserve) s.pinned = undefined;
      if (result.status === "saved") s.generated = result.artifact.version;
      s.gen =
        result.status === "failed"
          ? { input, ...summaryFailure(result.code) }
          : {
              input,
              status: result.status === "saved" ? "done" : "pending",
              message:
                result.status === "saved"
                  ? `Version ${result.artifact.version} saved. Earlier versions remain available.`
                  : "The summary is still being written. Check again shortly."
            };
      if (result.status === "saved" && !preserve) {
        s.selected = result.artifact.version;
        s.editing = false;
        s.compare = false;
      }
      if (result.status === "saved") ctx.refreshRecord?.();
      void load();
    } catch (error) {
      if (!mine()) return;
      if (accessDenied(error)) ws.outputs = { phase: "denied", data: null };
      s.gen = {
        input,
        ...(error?.status === 422 ? summaryFailure(error.code) : operationError(error))
      };
    }
    draw();
  }

  async function saveEdit() {
    const { artifact } = current();
    if (!artifact) return;
    const e = edit(artifact);
    if (e.op?.status === "running") return;
    const id = ws.id;
    const input =
      e.op?.status === "retry"
        ? e.op.input
        : { requestKey: randomKey(), expectedOutputVersion: head(), content: e.content };
    e.op = { input, status: "running", message: "Saving a new version…" };
    draw();
    const mine = () => stillHere(id) && e.op?.input.requestKey === input.requestKey;
    try {
      const saved = await api.editOutput(id, input);
      if (!stillHere(id)) return;
      if (mine()) e.op = { input, status: "done", message: `Saved version ${saved.version}.` };
      s.pinned = undefined;
      s.selected = saved.version;
      s.editing = false;
      void load();
    } catch (error) {
      if (!mine()) return;
      if (accessDenied(error)) ws.outputs = { phase: "denied", data: null };
      e.op = { input, ...operationError(error) };
    }
    draw();
  }

  async function review(candidateId, decision) {
    const { data } = current();
    const candidate = data?.candidates.find((c) => c.id === candidateId);
    if (!candidate) return;
    const rv = cand(candidate);
    if (rv.op?.status === "running") return;
    const id = ws.id;
    const uncertain = candidate.possibleMatchIds.length > 0;
    const input =
      rv.op?.status === "retry"
        ? rv.op.input
        : {
            requestKey: randomKey(),
            decision,
            ...(decision === "accept"
              ? { title: rv.title.trim(), dueAt: null, createDespitePossibleMatches: uncertain }
              : {})
          };
    rv.op = { input, status: "running", message: "Saving review…" };
    draw();
    try {
      const saved = await api.review(id, candidateId, input);
      if (!stillHere(id)) return;
      rv.result = saved;
      rv.op = {
        input,
        status: "done",
        message: saved.reviewState === "accepted" ? "Added to your Tasks." : "Dismissed."
      };
      void load();
    } catch (error) {
      if (!stillHere(id)) return;
      if (accessDenied(error)) ws.outputs = { phase: "denied", data: null };
      rv.op = { input, ...operationError(error) };
    }
    draw();
  }

  async function loadReceipts() {
    const id = ws.id;
    s.vault.receipts = { state: "loading", list: [] };
    try {
      const reply = await api.exports(id);
      if (!stillHere(id)) return;
      s.vault.receipts = { state: "ready", list: reply.receipts };
    } catch (error) {
      if (!stillHere(id)) return;
      s.vault.receipts = { state: "failed", list: [] };
    }
    draw();
  }

  async function saveVault() {
    const { artifact } = current();
    const v = s.vault;
    if (!artifact || v.op?.status === "running") return;
    const id = ws.id;
    const input =
      v.op?.status === "retry"
        ? v.op.input
        : { requestKey: randomKey(), artifactVersion: artifact.version };
    v.op = { input, status: "running", message: "Saving private copy…" };
    draw();
    try {
      const { receipt } = await api.saveExport(id, input);
      if (!stillHere(id)) return;
      v.receipt = receipt;
      v.op = { input, status: "done", message: exportStatus(receipt) };
    } catch (error) {
      if (!stillHere(id)) return;
      v.op = {
        input,
        ...(error?.code === "meeting_export_unavailable"
          ? {
              status: "failed",
              message:
                "Private export is unavailable. Check Meetings in Settings → Modules, then reopen the summary version. Notes is a required built-in module; contact an instance admin if export is still unavailable."
            }
          : error?.status === 409
            ? {
                status: "failed",
                message:
                  "The saved note was changed or removed. It has not been overwritten. Save a new summary version instead."
              }
            : operationError(error))
      };
    }
    draw();
  }

  /* ---------- rendering ---------- */

  const settingsHint = () =>
    hint(
      `Check your AI settings in ${btn("Settings → AI providers", "ai-settings", { variant: "link" })}.`
    );

  function modelRecovery() {
    return hint(
      `Check your default model in ${btn("Settings → AI providers", "ai-settings", { variant: "link" })}. Refresh summaries after the configuration is updated, then generate again.`
    );
  }

  function automaticNotices(data, artifact) {
    const auto = data.automaticSummary;
    if (!auto) return "";
    if (auto.status === "waiting") return status("Preparing automatic summary…");
    if (auto.status === "pending") return status("Writing summary…");
    if (auto.status === "failed") {
      const self = SELF_CONTAINED.has(auto.code ?? "");
      return `<div>${status(esc(summaryFailure(auto.code).message) + (self ? "" : " Use Rewrite summary to try again."))}${self ? settingsHint() : ""}</div>`;
    }
    if (auto.status === "skipped" && !artifact)
      return hint(
        auto.code === "setting-off"
          ? "Automatic summaries are off in Settings."
          : auto.code === "transcript-changed"
            ? "The transcript changed after import. Use Rewrite summary to use the latest evidence."
            : "There wasn’t enough finalized transcript to write a summary."
      );
    return "";
  }

  function rewriteControls(data) {
    const op = s.gen;
    const busy = op?.status === "running";
    const retry = op?.status === "retry" || op?.status === "pending";
    const type = recordingType();
    const avail = availability();
    const template = data.templates.find((t) => t.id === (type?.templateId ?? s.templateId));
    const blocked = avail !== "available";
    const unsaved = !!ctx.notesDirty?.();
    const styleField = type
      ? hint(`Summary style follows the recording type: ${esc(type.name)}.`)
      : field(
          "meeting-template",
          "Summary style",
          select(
            "meeting-template",
            [["", "Choose a style"], ...data.templates.map((t) => [t.id, t.name])],
            s.templateId,
            { model: "template", disabled: busy || retry }
          )
        );
    const sourceLoading = ws.transcript.phase === "loading";
    const blockedText =
      avail === "checking"
        ? "Checking summary model availability…"
        : avail === "subscription-unsupported"
          ? summaryFailure("meeting_output_subscription_unsupported").message
          : avail === "subscription-isolation-unavailable"
            ? summaryFailure("meeting_output_subscription_isolation_unavailable").message
            : avail === "model-unavailable"
              ? summaryFailure("meeting_output_route_unavailable").message
              : avail === "runner-offline"
                ? summaryFailure("meeting_output_runner_offline").message
                : "Couldn’t check summary model availability. Refresh summaries to try again.";
    return `<div class="meetings-actions">${styleField}${btn(
      retry ? "Check or retry summary" : data.headVersion ? "Rewrite summary" : "Write summary",
      "generate",
      { disabled: busy || (!retry && (blocked || !template || sourceLoading || unsaved)) }
    )}${btn("Refresh summaries", "refresh", { variant: "quiet", disabled: busy })}</div>${
      blocked ? status(esc(blockedText)) : ""
    }${unsaved ? note("Waiting for your notes to finish saving before rewriting.") : ""}`;
  }

  function versionSelect(data, artifact) {
    const options = [];
    if (s.pinned && !data.artifacts.some((a) => a.version === s.pinned.version))
      options.push([s.pinned.version, `Version ${s.pinned.version} · Kept edits`]);
    for (const a of data.artifacts)
      options.push([
        a.version,
        `Version ${a.version} · ${a.origin === "manual" ? "Manual edits" : "Generated"}${a.version === data.headVersion ? " · Latest" : ""}`
      ]);
    return field(
      "meeting-output-version",
      "Saved version",
      select("meeting-output-version", options, artifact?.version ?? "", { model: "version" })
    );
  }

  function artifactBlock(data, artifact, latest) {
    const tool = ws.tool;
    const typeId = ws.type.data?.metadata?.typeId ?? undefined;
    const template = data.templates.find((t) => t.id === artifact.templateId)?.name ?? "Meeting summary";
    const comparing = s.compare && latest && latest.version !== artifact.version;
    const shown = data.candidates.filter((c) => candidateShown(c, artifact, data));
    const vault = {
      ...s.vault,
      receipts: s.vault.receipts
    };
    return `<p class="jds-hint">${esc(template)} · ${artifact.origin === "manual" ? "Edited by you" : "Generated from saved sources"}</p>${
      artifact.stale ? note("Source text changed. This version may be out of date.") : ""
    }${artifact.inputs.transcript?.containsProvisional ? hint("Still being finalised") : ""}${
      (artifact.inputs.transcript?.omittedSegments ?? 0) > 0
        ? note(
            `Generated from a partial transcript: ${artifact.inputs.transcript.omittedSegments} segments omitted.`
          )
        : ""
    }${artifactContent(artifact, typeId)}<div class="meetings-actions">${btn(
      artifact.version === data.headVersion ? "Edit summary" : "Review kept edits",
      "edit-toggle",
      { variant: "secondary" }
    )}${
      tool === "versions" && latest && latest.version !== artifact.version
        ? btn(s.compare ? "Hide latest comparison" : "Compare with latest", "compare-toggle", {
            variant: "quiet"
          })
        : ""
    }</div>${
      comparing
        ? `<section class="meetings-section"><h3 class="jds-eyebrow jds-eyebrow--strong">Latest · version ${latest.version}</h3>${artifactContent(latest)}</section>`
        : ""
    }${s.editing ? editorHtml(artifact, data.headVersion, { ...edit(artifact), dirty: dirty(artifact) }) : ""}${
      shown.length ? sectionHead("Suggested tasks") : ""
    }${shown
      .map((c) => {
        const own = data.artifacts.find((a) => a.version === c.artifactVersion);
        const src = own ?? s.sources[c.artifactVersion]?.artifact;
        return candidateHtml(c, src, {
          ...cand(c),
          sourceFailed: s.sources[c.artifactVersion]?.state === "failed"
        });
      })
      .join("")}<div${tool === "vault" ? "" : " hidden"}>${vaultHtml(artifact.version, vault)}</div>`;
  }

  function render() {
    const tool = ws.tool;
    const o = out();
    const { data, artifact, latest } = current();
    let body;
    if (o.phase === "denied") body = `<p role="alert" class="jds-hint">${DENIED}</p>`;
    else if (o.phase === "failed")
      body = `<p role="alert" class="jds-hint">Couldn’t load summaries. Retry to continue.</p>${btn("Retry loading summaries", "outputs-retry", { variant: "secondary" })}`;
    else if (!data) body = status("Loading summaries…");
    else {
      const generatedHint =
        s.generated && artifact?.version !== s.generated
          ? `<div class="meetings-actions"><p class="jds-hint">The new version is ready. Your kept edits stay with their original version.</p>${btn("View generated version", "view-generated", { variant: "secondary" })}</div>`
          : "";
      const op = s.gen;
      const avail = availability();
      body = `${automaticNotices(data, artifact)}${tool === "rewrite" ? rewriteControls(data) : ""}${
        op ? status(esc(op.message)) : ""
      }${
        ((avail === "model-unavailable" || avail === "runner-offline") && tool === "rewrite") ||
        op?.remediation === "ai-settings"
          ? settingsHint()
          : ""
      }${op?.remediation === "ai-providers" ? modelRecovery() : ""}${generatedHint}${
        data.omittedArtifactCount
          ? hint("Showing recent versions. Open an older task suggestion to see its source text.")
          : ""
      }${
        data.artifacts.length
          ? `<div${tool === "versions" ? "" : " hidden"}>${versionSelect(data, artifact)}</div>`
          : !artifact && tool !== "rewrite"
            ? hint(
                "A summary appears after Stop or completed import when enabled in Settings. Use Rewrite summary to create one yourself."
              )
            : ""
      }${artifact ? artifactBlock(data, artifact, latest) : ""}`;
    }
    const header = tool
      ? `<div class="meetings-actions">${eyebrow(TOOL_TITLE[tool])}${btn("Done", "tool-done", { variant: "link" })}</div>`
      : "";
    const copy =
      tool === "copy"
        ? copyHtml(
            markdownBody(
              ws.meeting,
              artifact,
              ws.transcript.phase === "denied" ? undefined : ws.transcript.data
            ),
            !!ws.transcript.data?.snapshot.omittedSegments,
            s.copyStatus
          )
        : "";
    return `<section class="meetings-section" aria-label="Summary and actions">${header}${copy}${body}</section>`;
  }

  /* ---------- events ---------- */

  const closeEditor = () => {
    s.editing = false;
  };

  const acts = {
    "outputs-retry": () => void load(),
    refresh: () => void load(),
    generate: () => void generate(),
    "tool-done": () => {
      ws.tool = null;
      draw();
    },
    "view-generated": () => {
      s.selected = s.generated;
      closeEditor();
      s.compare = false;
      draw();
    },
    "edit-toggle": () => {
      const { artifact } = current();
      if (!artifact) return;
      s.pinned = artifact;
      s.selected = artifact.version;
      s.editing = !s.editing;
      if (s.editing) focus("output-overview");
      draw();
    },
    "compare-toggle": () => {
      s.compare = !s.compare;
      draw();
    },
    "edit-save": () => void saveEdit(),
    "edit-close": () => {
      closeEditor();
      draw();
    },
    "edit-discard": () => {
      const { artifact } = current();
      if (artifact) s.edits[artifact.version] = { content: baseline(artifact), op: null };
      closeEditor();
      draw();
    },
    review: (el) => void review(el.dataset.cand, el.dataset.decision),
    "cand-source": (el) => void loadSource(Number(el.dataset.version)),
    "go-tasks": () => ctx.navigate?.("/tasks"),
    "ai-settings": () => ctx.navigate?.("/settings?section=aiproviders"),
    "vault-save": () => void saveVault(),
    "copy-md": async () => {
      const { artifact } = current();
      const body = markdownBody(
        ws.meeting,
        artifact,
        ws.transcript.phase === "denied" ? undefined : ws.transcript.data
      );
      try {
        if (!globalThis.navigator?.clipboard) throw new Error("Clipboard unavailable");
        await globalThis.navigator.clipboard.writeText(body);
        s.copyStatus = "Copied";
      } catch {
        s.copyStatus = "Couldn’t copy automatically. Select and copy the text above.";
      }
      draw();
    }
  };

  /** Returns true when the field belongs to this pane. */
  function input(name, value) {
    const { artifact } = current();
    if (name === "template") {
      s.templateId = value;
      draw();
      return true;
    }
    if (name === "version") {
      s.selected = Number(value);
      closeEditor();
      draw();
      return true;
    }
    if (name.startsWith("cand:")) {
      const c = out().data?.candidates.find((x) => x.id === name.slice(5));
      if (c) cand(c).title = value;
      draw();
      return true;
    }
    if (!artifact || !s.editing) return name === "kept" || name === "markdown";
    const c = edit(artifact).content;
    if (name === "ov") c.overview = value;
    else {
      const [kind, index] = name.split(":");
      const i = Number(index);
      if (kind === "decisions" || kind === "actions")
        c[kind] = c[kind].map((x, n) => (n === i ? { ...x, text: value } : x));
      else if (kind === "question")
        c.openQuestions = c.openQuestions.map((x, n) => (n === i ? value : x));
      else return false;
    }
    refreshEditorButtons(artifact);
    return true;
  }

  /** Typing updates the save button without a redraw, so the caret stays put. */
  function refreshEditorButtons(artifact) {
    const save = globalThis.document?.querySelector('[data-act="edit-save"]');
    if (save) save.disabled = !dirty(artifact) || artifact.version !== head();
  }

  return { start, render, acts, input, openTool };
}
