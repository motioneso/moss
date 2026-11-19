import { esc } from "./view.mjs";

/** A prepared card from prepareCommitmentAction, for the chat host to mount. No writes here. */
export function reviewCardHtml(card, action, { busy = false, error = "", outcome = "" } = {}) {
  const title = {
    accept: "Accept commitment",
    reject: "Reject commitment",
    snooze: "Snooze commitment"
  }[action];
  if (!title || typeof card?.target !== "string" || typeof card?.version !== "string")
    throw new Error("A stored commitment approval card is required");
  return `<div class="action-request-card" role="region" aria-label="Action request"><div class="jds-card jds-card--pad-sm"><div class="action-request-stack">
    <h2 class="action-request-title">${title}</h2><p class="action-request-target">${esc(card.target)}</p>
    <dl class="action-request-fields">${(card.fields ?? []).map((f) => `<div class="action-request-field"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join("")}</dl>
    ${error ? `<p class="jds-hint jds-hint--error" role="alert">${esc(error)}</p>` : ""}
    ${outcome ? `<p class="jds-caption" role="status">${esc(outcome)}</p>` : `<div class="action-request-actions"><button type="button" class="jds-btn jds-btn--primary" data-decision="approve"${busy ? " disabled" : ""}>Approve</button><button type="button" class="jds-btn jds-btn--secondary" data-decision="reject"${busy ? " disabled" : ""}>Reject</button></div>`}
    </div></div></div>`;
}

/** The future chat host owns the one-use approval, version validation and execution. */
export function mountReviewCard(root, card, action, decide) {
  let busy = false;
  const render = (state) => {
    root.innerHTML = reviewCardHtml(card, action, state);
  };
  render({});
  const click = async (event) => {
    const button = event.target.closest?.("[data-decision]");
    if (!button || !root.contains(button) || busy) return;
    busy = true;
    render({ busy });
    try {
      await decide({ approve: button.dataset.decision === "approve", version: card.version });
      render({
        outcome: button.dataset.decision === "approve" ? "Approved." : "Declined. Nothing changed."
      });
    } catch {
      render({ error: "That decision couldn't be saved. Try again." });
    } finally {
      busy = false;
    }
  };
  root.addEventListener("click", click);
  return () => root.removeEventListener("click", click);
}
