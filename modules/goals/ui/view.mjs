export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c]
  );
}

const target =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';

export function goalsHtml(goals) {
  const active = goals.filter((g) => g.status === "active");
  if (!active.length) return "";
  return `<section class="jds-brief" aria-labelledby="goals-title">
    <div class="jds-brief__head"><span class="jds-brief__kicker">Focus</span></div>
    <h2 class="jds-brief__title" id="goals-title">Long-term goals</h2>
    <div class="loose">${active
      .map(
        (g) => `<div class="jds-task">
      <span class="jds-task__check">${target}</span>
      <div class="jds-task__main"><div class="jds-task__title">${escapeHtml(g.title)}</div>
        <div class="jds-task__meta">${g.priority ? `<span class="jds-drift"><span class="jds-drift__dot"></span>P${escapeHtml(g.priority)}</span>` : ""}
          <span class="jds-task__source">${escapeHtml(g.desiredOutcome)}</span>
        </div>
      </div>
    </div>`
      )
      .join("")}</div>
  </section>`;
}
