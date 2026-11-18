/** Pure rendering and range maths for the Backtrack settings screen. Server text is escaped here. */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const HOUR_MS = 60 * 60 * 1000;
const INFO =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

export const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatReceived(iso, timeZone) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone
  });
}

/** [from, to) for the last hour. Days come from the server in the account's time zone. */
export const lastHourRange = (now) => ({
  from: new Date(now.getTime() - HOUR_MS).toISOString(),
  to: now.toISOString()
});
/** Whole days from the `YYYY-MM-DD` day `today` back to `chosen`; undefined for a bad or future day. */
export function daysBack(today, chosen) {
  const parse = (text) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
    if (!m) return undefined;
    const at = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return new Date(at).getUTCDate() === +m[3] ? at : undefined;
  };
  const [t, c] = [parse(today), parse(chosen)];
  if (t === undefined || c === undefined || c > t) return undefined;
  return Math.round((t - c) / 86400000);
}
export const formatDay = (fromIso, timeZone) =>
  new Date(fromIso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone
  });

const head =
  '<div class="pane__head"><h1 class="pane__title">Backtrack</h1><p class="pane__desc">Your day memory: the text Trail Marker read from your screen, kept in Moss.</p></div>';
const note = (text, role = "status") =>
  `<p class="set2-note" role="${role}">${INFO}<span>${esc(text)}</span></p>`;
const button = (tone, label, act, extra = "") =>
  `<button class="jds-btn jds-btn--${tone} jds-btn--sm" data-act="${act}"${extra}>${esc(label)}</button>`;
const group = (title, desc, body, action = "") =>
  `<section class="pane__card"><header class="pane__cardhead"><div class="pane__cardheadmain"><h2 class="pane__cardtitle">${esc(title)}</h2><div class="pane__carddesc">${esc(desc)}</div></div>${
    action ? `<div class="pane__cardaction">${action}</div>` : ""
  }</header><div class="pane__cardbody">${body}</div></section>`;
const row = (name, desc, control, cls = "") =>
  `<div class="set-row${cls ? ` ${cls}` : ""}"><div class="set-row__main"><div class="set-row__name">${esc(name)}</div>${
    desc ? `<div class="set-row__desc">${esc(desc)}</div>` : ""
  }</div><div class="set-row__control">${control}</div></div>`;

export const loading = () => `${head}${note("Loading Backtrack…")}`;
export const broken = () =>
  `${head}${note("Could not load Backtrack.", "alert")}<div class="bt-actions">${button("secondary", "Try again", "retry")}</div>`;
export const noMac = () =>
  `${head}<div class="jds-empty"><div class="jds-empty__title">No Mac is linked</div><div class="jds-empty__sub">Link Trail Marker for Mac, then turn Backtrack on in its Settings. Link it from Account settings.</div></div>`;

/** What each Delete button asks before it deletes. */
export function confirmation(kind, data, range) {
  if (kind === "hour") {
    return {
      title: "Delete the last hour?",
      description: "This removes what Backtrack kept from the last hour. It can't be undone.",
      action: "Delete the last hour"
    };
  }
  if (kind === "today") {
    return {
      title: "Delete today?",
      description: "This removes what Backtrack kept since midnight today. It can't be undone.",
      action: "Delete today"
    };
  }
  if (kind === "day") {
    return {
      title: `Delete ${formatDay(range.from, range.timezone)}?`,
      description:
        "This removes what Backtrack kept on that day, midnight to midnight. It can't be undone.",
      action: "Delete the day"
    };
  }
  return {
    title: "Delete all of Backtrack?",
    description: `This removes the ${plural(data.days, "day", "days")} of text Moss has kept. It can't be undone. Backtrack keeps recording from now on unless you turn it off.`,
    action: "Delete everything"
  };
}

function confirmBox(confirming) {
  if (!confirming) return "";
  return `<div class="bt-confirm" role="alertdialog" aria-labelledby="bt-confirm-title" aria-describedby="bt-confirm-desc"><div class="bt-confirm__title" id="bt-confirm-title">${esc(
    confirming.title
  )}</div><div class="bt-confirm__desc" id="bt-confirm-desc">${esc(confirming.description)}</div><div class="bt-actions">${button(
    "secondary",
    "Cancel",
    "cancel",
    ' id="bt-cancel"'
  )}${button("danger", confirming.action, "confirm")}</div></div>`;
}

function deleteGroup(ui) {
  const off = ui.pending ? " disabled" : "";
  const dayOff = ui.pending || ui.tz.state !== "ready" ? " disabled" : "";
  const buttons = `<span class="bt-actions">${button("secondary", "Last hour", "hour", off)}${button(
    "secondary",
    "Today",
    "today",
    dayOff
  )}${button("secondary", "Choose a day…", "choose", dayOff)}${button("danger", "Everything…", "all", off)}</span>`;
  const dayRow = ui.choosingDay
    ? row(
        "Delete one day",
        "The day runs from midnight to midnight in your time zone.",
        `<span class="bt-actions"><input type="date" class="jds-input" id="bt-day" aria-label="Day to delete" max="${esc(ui.tz.date ?? "")}" value="${esc(ui.day)}">${button(
          "danger",
          "Delete that day",
          "day",
          ui.pending || ui.tz.state !== "ready" || daysBack(ui.tz.date, ui.day) === undefined
            ? " disabled"
            : ""
        )}</span>`,
        "set-row--stack-narrow"
      )
    : "";
  let result = "";
  if (ui.result) {
    result =
      ui.result.deleted === 0
        ? note("Nothing was kept in that time.")
        : note(`Deleted ${plural(ui.result.deleted, "stored segment", "stored segments")}.`);
  }
  if (ui.deleteFailed) result = note("Could not delete. Try again.", "alert");
  const zone =
    ui.tz.state === "failed"
      ? `${note("Could not load your time zone, so deleting by day is off.", "alert")}<div class="bt-actions">${button("secondary", "Try again", "retry-tz")}</div>`
      : "";
  return group(
    "Delete",
    "Deleting is permanent, and it works whether or not a Mac is linked.",
    `${row("Delete recent history", "Removes what Backtrack kept in that time, for you only.", buttons, "set-row--stack-narrow")}${dayRow}${confirmBox(
      ui.confirming
    )}${result}${zone}`
  );
}

/** The whole screen for a loaded status. `ui` holds the screen's local state. */
export function screen(data, ui) {
  const hasHistory = data.days > 0 || data.bytes > 0;
  if (data.storage === "off") {
    return `${head}${note("Backtrack storage isn't available on this Moss yet. An admin has to turn it on.")}${
      hasHistory
        ? `${note("Text kept from an earlier time is still stored, and you can delete it here.")}${deleteGroup(ui)}`
        : ""
    }`;
  }
  if (data.macs === 0 && !hasHistory) return noMac();
  const badge = `<span class="jds-badge jds-badge--${data.paused ? "amber" : "forest"}"><span class="jds-badge__dot"></span>${esc(
    data.paused ? "Paused" : `On · ${plural(data.macs, "Mac", "Macs")}`
  )}</span>`;
  const sw = `<label class="jds-switch"><input type="checkbox" id="bt-recording" aria-label="Recording"${
    data.paused ? "" : " checked"
  }${ui.pausing ? " disabled" : ""}><span class="jds-switch__track"><span class="jds-switch__thumb"></span></span></label>`;
  const recording = group(
    "Recording",
    "Turning a Mac's recording on happens on that Mac, with its consent. This switch pauses Backtrack for every Mac.",
    `${row(
      "Recording",
      data.paused ? "Paused from Moss: nothing new is stored." : "Moss stores what your Macs send.",
      sw
    )}${data.macs === 0 ? note("No Mac is linked. Link Trail Marker for Mac to record more.") : ""}${
      ui.pauseFailed ? note("Could not change recording. Try again.", "alert") : ""
    }`,
    badge
  );
  const kept = group(
    "Kept",
    "Backtrack keeps text for 37 days, plus up to one hourly run, then deletes it.",
    `${row("Days kept", "", `<span>${esc(plural(data.days, "day", "days"))}</span>`)}${row(
      "Stored",
      "",
      `<span>${esc(formatBytes(data.bytes))}</span>`
    )}${
      data.lastReceivedAt
        ? row(
            "Last received",
            "",
            `<span>${esc(formatReceived(data.lastReceivedAt, ui.tz.timezone ?? undefined))}</span>`
          )
        : ""
    }`
  );
  return `${head}${recording}${kept}${deleteGroup(ui)}`;
}
