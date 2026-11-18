/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { meetingsApi } from "./api.mjs";
import { esc } from "./format.mjs";
import { alertHint, btn, field, hint, select, sectionHead, status, textarea } from "./kit.mjs";
import { audioOptions, checkVocabulary, languageOptions, savedMode } from "./settings-logic.mjs";

const root = document.getElementById("root");
const client = moduleClient();
const api = meetingsApi(client);
const names = new Intl.DisplayNames(["en"], { type: "language" });
const languages = languageOptions((code) => names.of(code));

const s = {
  prefs: null,
  phase: "loading",
  macs: { phase: "loading", list: [] },
  vocab: "",
  vocabDirty: false,
  busy: false,
  error: "",
  vocabMessage: "",
  vocabError: ""
};

const failedAccess = (error) => error?.status === 401 || error?.status === 403;

async function loadPrefs() {
  s.phase = "loading";
  draw();
  try {
    s.prefs = await api.preferences();
    if (!s.vocabDirty) s.vocab = (s.prefs.transcriptVocabulary ?? []).join("\n");
    s.phase = "ready";
  } catch (error) {
    s.phase = failedAccess(error) ? "denied" : "failed";
  }
  draw();
}

async function loadMacs() {
  s.macs = { phase: "loading", list: s.macs.list };
  draw();
  try {
    const reply = await api.devices();
    s.macs = { phase: "ready", list: reply.devices ?? [] };
  } catch (error) {
    s.macs = { phase: failedAccess(error) ? "denied" : "unavailable", list: s.macs.list };
  }
  draw();
}

async function save(changes, { vocabulary = false } = {}) {
  if (s.busy) return;
  s.busy = true;
  s.error = "";
  if (vocabulary) {
    s.vocabError = "";
    s.vocabMessage = "";
  }
  draw();
  try {
    s.prefs = await api.putPreferences(changes);
    if (vocabulary) {
      s.vocab = (s.prefs.transcriptVocabulary ?? []).join("\n");
      s.vocabDirty = false;
      s.vocabMessage = changes.transcriptVocabulary.length
        ? "Vocabulary saved."
        : "Vocabulary cleared.";
    }
  } catch {
    const text = "Couldn’t save your settings.";
    if (vocabulary) s.vocabError = text;
    else s.error = text;
    s.retry = () => save(changes, { vocabulary });
  }
  s.busy = false;
  draw();
}

function vocabularyProblem() {
  if (!s.prefs) return "";
  try {
    checkVocabulary(s.prefs.transcriptLanguage, s.vocab);
    return "";
  } catch (error) {
    return error.message;
  }
}

function macsSection() {
  if (s.macs.phase === "denied")
    return alertHint("Mac access could not be verified. Sign in again.");
  if (s.macs.phase === "loading" && !s.macs.list.length) return status("Checking your linked Mac…");
  const unavailable = s.macs.phase === "unavailable";
  const rows = s.macs.list
    .map(
      (mac) =>
        `<div><div class="meeting-settings-mac"><strong>${esc(mac.deviceName)}</strong><span class="jds-badge jds-badge--${unavailable ? "amber" : "forest"}">${unavailable ? "Link status unconfirmed" : "Linked"}</span></div><hr class="jds-divider" /></div>`
    )
    .join("");
  const none =
    !s.macs.list.length && !unavailable
      ? hint("No Mac linked. Open Trail Marker and follow its linking instructions.")
      : "";
  const again = unavailable
    ? `<p role="status" class="jds-hint">Couldn’t confirm the latest Mac connection. ${btn("Check again", "macs", { variant: "link" })}</p>`
    : "";
  return `<div class="meeting-settings-macs">${rows}${none}</div>${again}`;
}

function prefsSection() {
  if (s.phase === "denied") return alertHint("Mac access could not be verified. Sign in again.");
  if (s.phase === "loading") return status("Loading your meeting settings…");
  if (s.phase === "failed")
    return `<p role="alert" class="jds-hint jds-hint--error">Couldn’t load your meeting settings. ${btn("Retry loading settings", "reload", { variant: "link" })}</p>`;
  const p = s.prefs;
  const problem = vocabularyProblem();
  const language = [["", "Automatic detection"], ...languages];
  return `
    <div class="meeting-settings-audio">
      ${field("meeting-settings-audio", "Audio source", select("meeting-settings-audio", audioOptions(p), savedMode(p), { model: "mode", disabled: s.busy }))}
    </div>
    ${field(
      "meeting-settings-language",
      "Transcript language",
      select("meeting-settings-language", language, p.transcriptLanguage ?? "", {
        model: "language",
        disabled: s.busy
      }),
      hint("Used for upcoming transcription, including imports. Existing text stays unchanged.")
    )}
    ${
      !p.transcriptLanguage && s.vocab.trim()
        ? hint("Clear vocabulary before choosing Automatic detection.")
        : ""
    }
    ${field(
      "meeting-settings-vocabulary",
      "Transcript vocabulary",
      textarea("meeting-settings-vocabulary", s.vocab, {
        rows: 4,
        max: 2000,
        model: "vocab",
        disabled: s.busy
      }),
      `<p class="jds-hint">One spelling per line, up to 20. Choose a transcript language and use spellings in that language. The complete hint, including separators, must fit within 200 UTF-8 bytes. Saved spellings go to your selected audio service for upcoming meeting clips and normal imports. Hints are best effort: the service may ignore them and accuracy is not guaranteed. Existing text and hold recordings stay unchanged.</p>
       <p class="jds-hint" role="status">${esc(problem)}</p>
       <div class="meeting-vocabulary-actions">${btn("Save vocabulary", "vocab-save", { disabled: s.busy || !!problem })}${btn("Clear vocabulary", "vocab-clear", { variant: "quiet", disabled: s.busy })}</div>
       ${s.vocabError ? `<p role="alert" class="jds-hint jds-hint--error">${esc(s.vocabError)} ${btn("Retry", "retry", { variant: "link" })}</p>` : ""}
       ${s.vocabMessage ? status(esc(s.vocabMessage)) : ""}`
    )}
    <label class="jds-switch"><input type="checkbox" data-in="summarize" id="meeting-settings-summarize"${p.summarizeOnStop ? " checked" : ""}${s.busy ? " disabled" : ""} /><span class="jds-switch__track"><span class="jds-switch__thumb"></span></span><span class="jds-switch__label">Summarize automatically after Stop</span></label>
    ${hint("Uses your default model after recording or import. You can also use Rewrite summary.")}
    ${s.busy ? status("Saving…") : ""}
    ${s.error ? `<p role="alert" class="jds-hint jds-hint--error">${esc(s.error)} ${btn("Retry", "retry", { variant: "link" })}</p>` : ""}`;
}

function draw() {
  const focused = document.activeElement;
  const active = focused?.id;
  let caret = null;
  try {
    caret = { start: focused?.selectionStart, end: focused?.selectionEnd };
  } catch {
    caret = null;
  }
  root.innerHTML = `${sectionHead("Meetings")}${macsSection()}${prefsSection()}`;
  const next = active ? document.getElementById(active) : null;
  if (next) next.focus({ preventScroll: true });
  if (next && caret && typeof caret.start === "number")
    next.setSelectionRange?.(caret.start, caret.end);
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

root.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-act]");
  if (!target || target.disabled) return;
  const act = target.dataset.act;
  if (act === "macs") void loadMacs();
  else if (act === "reload") void loadPrefs();
  else if (act === "retry") void s.retry?.();
  else if (act === "vocab-save") {
    try {
      void save(
        { transcriptVocabulary: checkVocabulary(s.prefs.transcriptLanguage, s.vocab) },
        { vocabulary: true }
      );
    } catch (error) {
      s.vocabError = error.message;
      draw();
    }
  } else if (act === "vocab-clear") void save({ transcriptVocabulary: [] }, { vocabulary: true });
});
root.addEventListener("input", (event) => {
  if (event.target.dataset?.in === "vocab") {
    s.vocab = event.target.value;
    s.vocabDirty = true;
    s.vocabMessage = "";
    s.vocabError = "";
    draw();
  }
});
root.addEventListener("change", (event) => {
  const name = event.target.dataset?.in;
  if (name === "mode") void save({ defaultCaptureMode: event.target.value });
  else if (name === "language") void save({ transcriptLanguage: event.target.value || null });
  else if (name === "summarize") void save({ summarizeOnStop: event.target.checked });
});

void loadPrefs();
void loadMacs();
