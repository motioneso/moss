/* global document */
import { esc } from "./format.mjs";
import { btn } from "./kit.mjs";
import { approvalCopy, decisionBody } from "./devices-logic.mjs";

const mac = `<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>`;
const phone = `<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>`;

const frame = (title, body, foot) =>
  `<div class="jds-dialog-scrim"><div class="jds-dialog pair-dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title"><div class="jds-dialog__head"><div class="jds-dialog__heading"><div class="jds-dialog__title" id="dlg-title">${title}</div></div></div><div class="jds-dialog__body">${body}</div><div class="jds-dialog__foot">${foot}</div></div></div>`;

/**
 * The approval dialog that opens over Meetings when a Mac or phone asks to link. The code
 * comes from the address the app opened and stays in memory only.
 */
export function linkDialog({ api, onLinked }) {
  const host = document.createElement("div");
  document.body.append(host);
  const s = { phase: "idle", attempt: null, code: "", busy: false, error: "" };

  const done = () => {
    s.phase = "idle";
    s.code = "";
    host.innerHTML = "";
  };

  function draw() {
    if (s.phase === "idle") return;
    if (s.phase === "checking") {
      host.innerHTML = frame("Checking the request…", `<p role="status" class="jds-hint">One moment.</p>`, "");
      return;
    }
    if (s.phase === "closed")
      host.innerHTML = frame(
        "That request is no longer open",
        "<p>Start again from the Mac app.</p>",
        btn("Close", "link-close", { id: "link-close" })
      );
    else if (s.phase === "declined")
      host.innerHTML = frame(
        "Nothing was linked",
        `<p>The ${s.attempt.platform === "android" ? "phone" : "Mac"} gets no access.</p>`,
        btn("Close", "link-close", { id: "link-close" })
      );
    else if (s.phase === "signin")
      host.innerHTML = frame(
        "Sign in again to link",
        "<p>Your session needs to be refreshed. Reload Moss and open the link again.</p>",
        btn("Close", "link-close", { id: "link-close" })
      );
    else if (s.phase === "failed")
      host.innerHTML = frame(
        "Couldn’t check the request",
        `<p role="alert" class="jds-hint jds-hint--error">Something went wrong. Try again.</p>`,
        `${btn("Close", "link-close", { variant: "secondary" })}${btn("Try again", "link-retry", { id: "link-retry" })}`
      );
    else {
      const c = approvalCopy(s.attempt);
      host.innerHTML = frame(
        esc(c.title),
        `<div class="pair-ask"><span class="pair-icon">${s.attempt.platform === "android" ? phone : mac}</span><div><div class="pair-name">${esc(c.name)}</div><div class="pair-meta"><span>${c.os} · Asked just now</span></div></div></div><p class="pair-can-title">It will be able to</p><ul class="pair-can">${c.can.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${s.error ? `<p role="alert" class="jds-hint jds-hint--error">${esc(s.error)}</p>` : ""}`,
        `${btn(esc(c.deny), "link-deny", { variant: "secondary", disabled: s.busy })}${btn(s.busy ? "Linking…" : esc(c.link), "link-approve", { id: "link-approve", disabled: s.busy })}`
      );
    }
    host.querySelector("#link-close, #link-approve, #link-retry")?.focus();
  }

  async function open(code) {
    s.code = code;
    s.phase = "checking";
    s.error = "";
    draw();
    try {
      const attempt = await api.linkAttempt(code);
      s.attempt = attempt;
      s.phase = attempt.status === "pending" ? "ask" : "closed";
    } catch (error) {
      s.phase = error?.status === 404 ? "closed" : error?.status === 401 || error?.status === 403 ? "signin" : "failed";
    }
    draw();
  }

  async function decide(approve) {
    if (s.busy) return;
    s.busy = true;
    s.error = "";
    draw();
    try {
      await api.linkDecide(decisionBody(s.code, approve, s.attempt));
      s.busy = false;
      if (approve) {
        done();
        onLinked();
        return;
      }
      s.phase = "declined";
    } catch (error) {
      s.busy = false;
      if (error?.status === 404 || error?.status === 409) s.phase = "closed";
      else if (error?.status === 401) s.phase = "signin";
      else s.error = "Couldn’t send your answer. Try again.";
    }
    draw();
  }

  host.addEventListener("click", (event) => {
    const act = event.target.closest?.("[data-act]")?.dataset.act;
    if (act === "link-close") done();
    else if (act === "link-approve") void decide(true);
    else if (act === "link-deny") void decide(false);
    else if (act === "link-retry") void open(s.code);
  });
  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !s.busy) done();
    else if (event.key === "Tab") {
      const buttons = [...host.querySelectorAll("button:not(:disabled)")];
      const at = buttons.indexOf(document.activeElement);
      if (buttons.length && (at === -1 || (event.shiftKey ? at === 0 : at === buttons.length - 1))) {
        event.preventDefault();
        buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
      }
    }
  });
  return { open };
}
