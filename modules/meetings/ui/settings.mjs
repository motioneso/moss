/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { meetingsApi } from "./api.mjs";
import { esc } from "./format.mjs";
import { alertHint, btn, field, hint, select, sectionHead, status, textarea } from "./kit.mjs";
import { devicesSection } from "./devices.mjs";
import { audioOptions, checkVocabulary, languageOptions, savedMode } from "./settings-logic.mjs";

const root = document.getElementById("root");
const client = moduleClient();
const api = meetingsApi(client);
const names = new Intl.DisplayNames(["en"], { type: "language" });
const languages = languageOptions((code) => names.of(code));

const s = {
  prefs: null,
  phase: "loading",
  vocab: "",
  vocabDirty: false,
  busy: false,
  error: "",
  vocabMessage: "",
  vocabError: ""
};

const linked = new URLSearchParams(document.location?.search).get("focus") === "linked";
const devices = devicesSection({ api, draw: () => draw(), linked });

const backLink = `<button type="button" class="jds-btn jds-btn--quiet pair-back" data-act="back"><svg aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" viewBox="0 0 24 24" width="18" height="18"><path d="M15 18l-6-6 6-6"/></svg><span>Recordings</span></button>`;

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
  let caret;
  try {
    caret = { start: focused?.selectionStart, end: focused?.selectionEnd };
  } catch {
    caret = null;
  }
  root.innerHTML = `${backLink}${devices.render()}${sectionHead("Meetings")}${prefsSection()}${devices.dialog()}`;
  const wanted = devices.takeFocus();
  const next = wanted ? document.getElementById(wanted) : active ? document.getElementById(active) : null;
  if (next) next.focus({ preventScroll: true });
  if (next && caret && typeof caret.start === "number")
    next.setSelectionRange?.(caret.start, caret.end);
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

root.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-act]");
  if (!target || target.disabled) return;
  const act = target.dataset.act;
  if (devices.acts[act]) devices.acts[act](target);
  else if (act === "back") void client.navigate("/meetings");
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
root.addEventListener("keydown", (event) => {
  if (event.key === "Escape") devices.escape();
  else if (event.key === "Tab" && devices.isOpen()) {
    const buttons = [...root.querySelectorAll(".jds-dialog button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement);
    if (buttons.length && (at === -1 || (event.shiftKey ? at === 0 : at === buttons.length - 1))) {
      event.preventDefault();
      buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
    }
  } else if (event.key === "Enter" && event.target.id === "device-name") {
    event.preventDefault();
    devices.submit();
  }
});
root.addEventListener("input", (event) => {
  if (event.target.dataset?.in === "device-name") devices.input("device-name", event.target.value);
  else if (event.target.dataset?.in === "vocab") {
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
void devices.start();
