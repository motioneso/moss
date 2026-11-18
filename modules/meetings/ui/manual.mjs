import { randomKey } from "./format.mjs";
import { alertHint, btn, field, hint, input, select, textarea } from "./kit.mjs";

/** Manual entry: paste a transcript and let Moss file and summarise it. */
export function manualScreen({ api, draw, go }) {
  const s = {
    title: "",
    typeId: "",
    transcript: "",
    types: { state: "loading", list: [] },
    phase: "idle",
    requestKey: null,
    error: ""
  };

  async function loadTypes() {
    s.types = { state: "loading", list: [] };
    try {
      const reply = await api.recordingTypes();
      s.types = { state: "ready", list: (reply.types ?? []).filter((t) => !t.retired) };
    } catch {
      s.types = { state: "failed", list: [] };
    }
    draw();
  }

  async function submit() {
    if (s.phase === "saving" || !s.transcript.trim()) return;
    s.requestKey ??= randomKey();
    const body = { requestKey: s.requestKey, transcript: s.transcript };
    if (s.title.trim()) body.title = s.title.trim();
    if (s.typeId) body.typeId = s.typeId;
    s.phase = "saving";
    s.error = "";
    draw();
    try {
      const reply = await api.manual(body);
      s.phase = "idle";
      s.requestKey = null;
      s.title = s.typeId = s.transcript = "";
      go({ view: "record", id: reply.meetingId });
    } catch (error) {
      if ([400, 409, 413].includes(error?.status)) {
        s.requestKey = null;
        s.phase = "idle";
        s.error = "Check the title, type and transcript, then try again.";
      } else {
        s.phase = "retry";
        s.error = "Couldn’t confirm your recording. Retry to check the same submission.";
      }
      draw();
    }
  }

  function render() {
    const saving = s.phase === "saving";
    const locked = saving || s.phase === "retry";
    return `<section class="meetings-section" aria-label="Add recording">
${btn("Meetings", "back", { variant: "link", disabled: locked })}
<h1 class="meetings-title">Add recording</h1>
<form data-form="manual">
<div class="meetings-manual-fields">
${field("recording-title", "Title (optional)", input("recording-title", s.title, { max: 240, model: "title", disabled: locked }))}
${field("recording-type", "Type (optional)", select("recording-type", [["", "Automatic"], ...s.types.list.map((t) => [t.id, t.name])], s.typeId, { model: "typeId", disabled: locked || s.types.state !== "ready" }))}
</div>
${s.types.state === "failed" ? `<p role="alert" class="jds-hint">Couldn’t load recording types. ${btn("Try again", "types-retry", { variant: "link" })}</p>` : ""}
${field("recording-transcript", "Transcript", textarea("recording-transcript", s.transcript, { rows: 14, max: 100000, placeholder: "Paste or type the transcript here…", model: "transcript", disabled: locked }))}
${hint("Moss will choose a title and type, decide personal or work, and write a summary. Any title or type you provide will be kept.")}
${s.error ? alertHint(s.error) : ""}
<div class="meetings-actions">
${btn(saving ? "Adding recording…" : s.phase === "retry" ? "Retry adding recording" : "Add recording", "submit", { type: "submit", disabled: saving || !s.transcript.trim() })}
${btn("Cancel", "back", { variant: "secondary", disabled: locked })}
</div>
</form>
</section>`;
  }

  return {
    start() {
      if (s.types.state !== "ready") void loadTypes();
    },
    render,
    input(name, value) {
      s[name] = value;
    },
    submit,
    acts: { back: () => go({ view: "home" }), "types-retry": () => void loadTypes() }
  };
}
