// One explicitly started synthetic-message click. No startup work or persistence.
(() => {
  if (globalThis.__mossAutoBodyProbe) return;
  let timer, route, deadline, previousBody = "";
  let state = { running: false, reason: "Not started", phase: "idle", scans: 0, opened: 0, capture: null };
  let phrase = "";
  const currentRoute = () => location.pathname + location.search + location.hash;
  const mailRoute = () => /^\/mail(?:\/|$)/i.test(location.pathname);
  const visible = (node) => !node.closest('[hidden], [aria-hidden="true"], [inert]')
    && getComputedStyle(node).visibility === "visible" && node.getClientRects().length > 0;
  const snapshot = () => ({ ...state, capture: state.capture ? { ...state.capture } : null });
  const finish = (reason) => {
    clearInterval(timer);
    timer = undefined;
    document.removeEventListener("pointerdown", interrupt, true);
    document.removeEventListener("keydown", interrupt, true);
    state.running = false;
    state.reason = reason;
    previousBody = "";
    return snapshot();
  };
  const stop = (reason = "Stopped and cleared") => {
    state.capture = null;
    state.phase = "idle";
    phrase = "";
    return finish(reason);
  };
  function interrupt(event) {
    if (event.isTrusted) stop("Page interaction; stopped and cleared. Start again with a fresh phrase.");
  }
  const matches = () => {
    const lists = [...document.querySelectorAll('[role="listbox"]')].filter((node) => visible(node)
      && /message|conversation|inbox/i.test(node.getAttribute("aria-label") || "")
      && !node.closest('nav, [role="navigation"], [role="dialog"], [contenteditable="true"]'));
    if (lists.length !== 1) return null;
    return [...lists[0].querySelectorAll('[role="option"]')].filter((node) => visible(node)
      && node.closest('[role="listbox"]') === lists[0]
      && !node.closest('[role="textbox"], [contenteditable="true"]')).slice(0, 50)
      .filter((node) => node.innerText.slice(0, 2000).toLowerCase().includes(phrase.toLowerCase()));
  };
  const tick = () => {
    if (!state.running) return;
    state.scans++;
    if (!mailRoute() || (state.phase === "waiting" && currentRoute() !== route)) {
      stop("Mail route changed; stopped and cleared."); return;
    }
    if (Date.now() >= deadline) {
      const detail = state.phase === "reading" ? ` Last check: ${state.reason}.` : "";
      stop(`Timed out; stopped and cleared.${detail} Use a fresh phrase to retry.`); return;
    }
    if (state.phase === "waiting") {
      const rows = matches();
      if (!rows) { stop("Message list unavailable or ambiguous; stopped and cleared."); return; }
      if (rows.length > 1) { stop("Several matching rows; stopped without opening mail."); return; }
      if (!rows.length) return;
      state.phase = "reading";
      state.opened = 1;
      deadline = Date.now() + 20000;
      state.reason = "Opened one matching row; waiting for its rendered body";
      try { rows[0].click(); } catch { stop("Could not open test row; stopped and cleared."); }
      return;
    }
    const capture = globalThis.__mossReadOpenedMessage(phrase);
    let pending = "";
    if (!capture.ok) pending = capture.reason === "identity" ? "Subject heading missing or does not match test phrase"
      : capture.reason === "ambiguous" ? "Several readable message bodies" : "No readable message body";
    else if (capture.truncated) pending = "Body exceeds the preview limit";
    else if (!capture.body.toLowerCase().includes(phrase.toLowerCase())) pending = "Body test phrase not found";
    else if (!capture.body.trimEnd().endsWith("MOSS BODY END")) pending = "Final body marker not found";
    if (pending) { state.reason = pending; previousBody = ""; return; }
    const signature = JSON.stringify(capture);
    if (signature !== previousBody) { state.reason = "Waiting for a second equal body snapshot"; previousBody = signature; return; }
    state.capture = capture;
    state.phase = "captured";
    finish("Captured one synthetic body locally; automation finished");
  };
  const start = (filter) => {
    stop();
    state.scans = state.opened = 0;
    if (!mailRoute() || typeof filter !== "string" || !/^MOSS BODY TEST\s+\S/i.test(filter.trim()) || filter.length > 80) {
      state.reason = "Open Inbox and use MOSS BODY TEST followed by a fresh unique suffix (80 characters maximum).";
      return snapshot();
    }
    phrase = filter.trim();
    const rows = matches();
    if (!rows || rows.length) return stop("Need one supported message list with no existing matching row. Use a fresh phrase.");
    route = currentRoute();
    deadline = Date.now() + 300000;
    state.running = true;
    state.phase = "waiting";
    state.reason = "Waiting for one new matching row; leave this tab untouched";
    document.addEventListener("pointerdown", interrupt, true);
    document.addEventListener("keydown", interrupt, true);
    timer = setInterval(tick, 2000);
    return snapshot();
  };
  globalThis.__mossAutoBodyProbe = { start, stop, snapshot };
})();
