import { accessDenied, esc, lineLabel, transcriptTime } from "./format.mjs";
import { btn, hint, input, note, sectionHead } from "./kit.mjs";

/** Transcript pane: timeline, search, and the referenced-line lookup. */
export function transcriptPane({ api, draw }, ws) {
  async function load() {
    const id = ws.id;
    const t = ws.transcript;
    t.phase = t.data ? "ready" : "loading";
    try {
      const data = await api.transcript(id);
      if (ws.id !== id) return;
      ws.transcript.data = data;
      ws.transcript.phase = "ready";
    } catch (error) {
      if (ws.id !== id) return;
      ws.transcript.phase = accessDenied(error)
        ? error.status === 404
          ? "notfound"
          : "denied"
        : "failed";
    }
    draw();
    scrollToReference();
  }

  async function loadEvidence() {
    const id = ws.id;
    const ref = ws.transcript.evidence;
    if (!ref) return;
    ws.transcript.evidenceState = "loading";
    try {
      const reply = await api.evidence(
        id,
        new URLSearchParams(Object.entries(ref).map(([k, v]) => [k, String(v)])).toString()
      );
      if (ws.id !== id) return;
      ws.transcript.evidenceData = reply.evidence;
      ws.transcript.evidenceState = "ready";
    } catch {
      if (ws.id !== id) return;
      ws.transcript.evidenceState = "failed";
    }
    draw();
    scrollToReference();
  }

  function scrollToReference() {
    const t = ws.transcript;
    const exact = t.evidenceData?.segment;
    if (!exact) return;
    const selected = t.data?.snapshot.segments.find(
      (l) => l.segmentId === exact.segmentId && l.revision === exact.revision
    );
    setTimeout(() => {
      const node = globalThis.document?.getElementById(
        selected ? `meeting-line-${exact.segmentId}` : `meeting-reference-${ws.id}`
      );
      node?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      node?.focus?.({ preventScroll: true });
    }, 0);
  }

  function start() {
    if (ws.transcript.evidence) void loadEvidence();
    void load();
  }

  function render() {
    const t = ws.transcript;
    const snap = t.data?.snapshot;
    const exact = t.evidenceState === "ready" ? t.evidenceData?.segment : undefined;
    const selected =
      exact &&
      snap?.segments.find((l) => l.segmentId === exact.segmentId && l.revision === exact.revision);
    const asked = !!t.evidence || t.evidenceState === "failed";
    const q = (t.search ?? "").toLocaleLowerCase();
    const lines = snap
      ? snap.segments.filter((l) => !q || l.text.toLocaleLowerCase().includes(q))
      : [];
    const denied = t.phase === "denied";
    let body = "";
    if (denied)
      body = hint(
        "Transcript access is unavailable. Return to Meetings or sign in again.",
        ' role="status"'
      );
    else if (snap) {
      body = `${snap.containsProvisional ? hint("Still being finalised") : ""}${
        snap.omittedSegments > 0
          ? note(
              `${snap.omittedSegments} ${snap.omittedSegments === 1 ? "line" : "lines"} not shown.`
            )
          : ""
      }<div class="meetings-transcript-timeline" aria-label="Transcript timeline">${lines
        .map((l) => {
          const live = l.finality === "provisional";
          const text =
            l.segmentId === selected?.segmentId
              ? `<mark class="jds-highlight">${esc(l.text)}</mark>`
              : esc(l.text);
          return `<article id="meeting-line-${esc(l.segmentId)}" tabindex="-1" class="meetings-transcript-turn${live ? " meetings-transcript-turn--live" : ""}" aria-label="Transcript at ${transcriptTime(l.startMs)}"><span class="jds-hint">${transcriptTime(l.startMs)}</span><div><span class="jds-label">${esc(lineLabel(l, t.data.sources))}</span><p class="meetings-transcript-text${live ? " jds-hint" : ""}">${text}</p></div></article>`;
        })
        .join("")}</div>${
        t.search !== null && snap.segments.length && !lines.length
          ? hint("No loaded timeline lines match.")
          : ""
      }<p class="jds-sr-only" role="status">${
        snap.segments.length
          ? `${snap.segments.length} transcript lines available, through ${transcriptTime(snap.throughMs ?? 0)}.`
          : ""
      }</p>${!snap.segments.length && t.search === null ? hint("Start when you’re ready.", ' role="status"') : ""}`;
    } else if (t.phase === "loading") body = hint("Loading transcript…");
    else if (t.phase === "failed")
      body = `<p class="jds-hint">Couldn’t load the transcript. ${btn("Try again", "transcript-retry", { variant: "link" })}</p>`;
    return `<section class="meetings-section" aria-label="Transcript">${sectionHead("Transcript")}
${
  t.search !== null
    ? `<div class="jds-field"><label class="jds-label" for="meeting-transcript-search">Search transcript timeline</label>${input("meeting-transcript-search", t.search, { type: "search", described: "meeting-transcript-search-scope", model: "tsearch" })}<p id="meeting-transcript-search-scope" class="jds-hint">Searches shown lines only.</p>${btn("Close search", "search-close", { variant: "link" })}</div>`
    : ""
}
${asked && t.evidenceState === "failed" ? hint("This transcript reference is unavailable. It may have changed or access was removed.", ' role="status"') : ""}
${t.evidenceState === "loading" ? hint("Loading referenced text…") : ""}
${exact && !selected && !denied ? `<article id="meeting-reference-${esc(ws.id)}" tabindex="-1"><span class="jds-hint">Earlier text at ${transcriptTime(exact.startMs)}</span><p class="meetings-transcript-text"><mark class="jds-highlight">${esc(t.evidenceData.excerpt)}</mark></p></article>` : ""}
${body}
</section>`;
  }

  return {
    start,
    render,
    reload: load,
    input(name, value) {
      if (name !== "tsearch") return false;
      ws.transcript.search = value;
      draw();
      return true;
    },
    acts: {
      evidence: (el) => {
        ws.transcript.evidence = {
          segmentId: el.dataset.seg,
          segmentRevision: Number(el.dataset.rev),
          startCharacter: Number(el.dataset.start),
          endCharacter: Number(el.dataset.end)
        };
        ws.transcript.evidenceData = undefined;
        if (ws.narrow) ws.tab = "transcript";
        void loadEvidence();
        void load();
      },
      "transcript-retry": () => void load(),
      "search-close": () => {
        ws.transcript.search = null;
        draw();
      }
    }
  };
}
