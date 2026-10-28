/*
 * Remote access screens, drawn with the real Moss markup and classes.
 * screen.html calls RENDER[m](state) and shows one screen. Needs shell.js first.
 */

/* Made-up sample data. */
const MACHINE = "moss-box";
const TSIP = "100.101.7.22";
const TSNAME = "moss-box.tail1234.ts.net";
const NAME = "jordan";
const FULL = `${NAME}.meetmoss.com`;

/* ---------- @moss/ui markup ---------- */

const ic = (n) => ICONS[n];

function btn(text, variant = "secondary", { size = "sm", icon = "", disabled = false } = {}) {
  const cls = ["jds-btn", `jds-btn--${variant}`, size !== "md" ? `jds-btn--${size}` : ""].filter(Boolean);
  const iconHtml = icon ? `<span class="jds-btn__icon">${ic(icon)}</span>` : "";
  return `<button type="button" class="${cls.join(" ")}"${disabled ? " disabled" : ""}>${iconHtml}${text}</button>`;
}

const ind = (label, status, live = false) =>
  `<span class="jds-indicator jds-indicator--${status}${live ? " jds-indicator--live" : ""}"><span class="jds-indicator__dot"></span><span>${label}</span></span>`;

const badge = (label, tone = "neutral") => `<span class="jds-badge jds-badge--${tone}">${label}</span>`;

const row = (name, desc, control = "") =>
  `<div class="set-row"><div class="set-row__main"><div class="set-row__name">${name}</div>${desc ? `<div class="set-row__desc">${desc}</div>` : ""}</div>${control ? `<div class="set-row__control">${control}</div>` : ""}</div>`;

const ctl = (...parts) => `<span class="ra-ctl">${parts.join("")}</span>`;

function group(title, body, { desc = "", action = "", danger = false } = {}) {
  return `<section class="pane__card${danger ? " pane__card--danger" : ""}"><header class="pane__cardhead"><div class="pane__cardheadmain"><h3 class="pane__cardtitle">${title}</h3>${desc ? `<div class="pane__carddesc">${desc}</div>` : ""}</div>${action ? `<div class="pane__cardaction">${action}</div>` : ""}</header><div class="pane__cardbody">${body}</div></section>`;
}

const paneHead = (title, desc = "") =>
  `<div class="pane__head"><h2 class="pane__title">${title}</h2>${desc ? `<p class="pane__desc">${desc}</p>` : ""}</div>`;

const note = (icon, html) => `<p class="set2-note">${ic(icon)}<span>${html}</span></p>`;

const actions = (...parts) => `<div class="gflow__links ra-actions">${parts.join("")}</div>`;

function guide(steps) {
  return `<ol class="onb-guide">${steps
    .map((t, i) => `<li class="onb-guide__step"><span class="onb-guide__n">${i + 1}</span><div class="onb-guide__body"><div class="onb-guide__t">${t}</div></div></li>`)
    .join("")}</ol>`;
}

const field = (label, control, { hint = "", error = "" } = {}) =>
  `<div class="fld"><div class="fld__lbl">${label}</div><div class="fld__row">${control}</div>${hint ? `<div class="fld__hint">${hint}</div>` : ""}${error ? `<div class="fld__hint jds-hint jds-hint--error" role="alert">${error}</div>` : ""}</div>`;

function dialog(title, desc, confirmLabel, danger = true) {
  return `<div class="jds-dialog-scrim"><div class="jds-dialog" role="dialog" aria-modal="true"><div class="jds-dialog__head"><div class="jds-dialog__heading"><div class="jds-dialog__title">${title}</div></div><div class="jds-dialog__desc">${desc}</div></div><div class="jds-dialog__body"></div><div class="jds-dialog__foot">${btn("Cancel", "quiet", { size: "md" })}${btn(confirmLabel, danger ? "danger" : "primary", { size: "md" })}</div></div></div>`;
}

const toast = (msg, tone = "ready") =>
  `<div class="set-toasts"><div class="jds-toast jds-toast--${tone}"><span class="jds-toast__icon">${ic("check")}</span><div class="jds-toast__body"><div class="jds-toast__msg">${msg}</div></div></div></div>`;

/* A fixed fake QR code. */
function qr(seed = 7) {
  let s = seed;
  let cells = "";
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const n = 25;
  const finder = (x, y) =>
    `<rect x="${x}" y="${y}" width="7" height="7" fill="currentColor"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="var(--surface-raised)"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="currentColor"/>`;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const inFinder = (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
      if (!inFinder && rnd() > 0.52) cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="currentColor"/>`;
    }
  return `<span class="ra-qr"><svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" aria-label="QR code">${cells}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg></span>`;
}

const copyBtn = () => btn("Copy", "quiet", { icon: "copy" });

/* ---------- App frame ---------- */

function app(content, { title = "Settings", overlay = "" } = {}) {
  const top = SHELL.top.replace('<span class="topbar-title">Settings</span>', `<span class="topbar-title">${title}</span>`);
  return `<div class="app-frame">${SHELL.side}<div class="workspace-area">${top}<div class="workspace-body"><main class="content-surface">${content}</main></div></div></div>${overlay}`;
}

function settings(pane, { wide = false, overlay = "" } = {}) {
  return app(
    `<div class="set2${wide ? " set2--wide" : ""}">${SHELL.mast}${SHELL.picker}<div class="set2__grid">${SHELL.nav}<div class="set2__pane">${pane}</div></div></div>`,
    { overlay }
  );
}

/* ---------- Guided setup: the Settings wide view ---------- */

const STEPS = [
  ["group", "Tailscale"],
  ["ts", "This computer"],
  ["devices", "Your phone and laptop"],
  ["https", "Secure address"],
  ["group", "meetmoss.com name"],
  ["intro", "About the name"],
  ["signin", "Sign in"],
  ["name", "Pick a name"],
  ["net", "Network check"],
  ["cert", "Certificate"],
];
const KEYS = STEPS.filter((s) => s[0] !== "group").map((s) => s[0]);

function rail(at, addrs, nameDone) {
  const steps = STEPS.map(([k, t]) => {
    if (k === "group") return `<li class="ra-steps__group">${t}</li>`;
    const i = KEYS.indexOf(k);
    const state = i < at ? " is-done" : i === at ? " is-now" : "";
    return `<li class="ra-steps__item${state}"><span class="ra-steps__dot">${i < at ? ic("check") : ""}</span>${t}</li>`;
  }).join("");

  const rows = [row("http://localhost:1533", "This computer", ind("Works", "ready"))];
  const plain = `http://${TSIP}:1533`;
  if (addrs === "base") rows.push(row(plain, "Your Tailscale devices", ind("Not set up", "idle")));
  else if (addrs === "tspending") rows.push(row(plain, "Your Tailscale devices", ind("Not checked yet", "idle")));
  else rows.push(row(plain, "Your Tailscale devices", ind("Works", "ready")));
  if (addrs === "ts" || addrs === "tspending") rows.push(row(`https://${TSNAME}`, "Secure", ind("Not set up", "idle")));
  if (addrs === "tsname") rows.push(row(`https://${TSNAME}`, "Secure", ind("Works", "ready")));
  if (addrs === "nohttps") rows.push(row(`https://${TSNAME}`, "Secure", ind("Not available", "drift")));
  if (addrs === "tsname" || addrs === "nohttps" || nameDone)
    rows.push(row(`https://${FULL}`, "Secure", nameDone ? ind("Works", "ready") : ind("Not set up", "idle")));

  return `<div class="ra-rail-steps"><ol class="ra-steps">${steps}</ol></div><span class="jds-eyebrow jds-eyebrow--strong">Addresses</span>${rows.join("")}`;
}

function flow(step, title, lede, body, { addrs = "base", nameDone = false, overlay = "" } = {}) {
  const at = KEYS.indexOf(step);
  const ts = at < 3;
  const pos = ts ? at + 1 : at - 2;
  const total = ts ? 3 : KEYS.length - 3;
  const meta = `${ts ? "Tailscale" : "meetmoss.com name"}, step ${pos} of ${total}`;
  const head = `<div class="jds-section-head jds-section-head--rule"><span class="jds-section-head__number">${String(pos).padStart(2, "0")}</span><h3 class="jds-section-head__title">${title}</h3><span class="jds-section-head__meta">${meta}</span></div>`;
  return chooser(`${head}${lede ? `<p class="pane__desc">${lede}</p>` : ""}${body}`, rail(at, addrs, nameDone), overlay);
}

function chooser(main, railHtml, overlay = "") {
  return settings(
    `<div class="gflow"><button type="button" class="gflow__back">${ic("back")}Back to remote access</button>${paneHead("Use Moss from other devices")}<div class="intg-detail"><div class="intg-detail__main">${main}</div><aside class="intg-detail__rail" aria-label="Setup">${railHtml}</aside></div></div>`,
    { wide: true, overlay }
  );
}

/* ---------- 1. Where you start ---------- */

function entry(s) {
  if (s === "choose") {
    const card = (value, label, desc, checked) =>
      `<label class="jds-radio-card"><input type="radio" name="access" value="${value}"${checked ? " checked" : ""}><span class="jds-radio-card__label">${label}</span><span class="jds-radio-card__description">${desc}</span></label>`;
    const main = `<div class="jds-section-head jds-section-head--rule"><h3 class="jds-section-head__title">Where will you open Moss?</h3></div>
      <div class="jds-radio-cards ra-block" role="radiogroup" aria-label="Where from">
        ${card("local", "Keep local", "Only this computer can open Moss.", false)}
        ${card("lan", "Home network (HTTP, unencrypted)", "Devices on your Wi-Fi. The connection isn't encrypted.", false)}
        ${card("anywhere", `From anywhere ${badge("Recommended", "forest")}`, "Your phone and laptop, at home or away, through Tailscale. Free for personal use.", true)}
      </div>
      ${actions(btn("Continue", "primary", { size: "md" }), btn("Cancel", "quiet", { size: "md" }))}`;
    return chooser(main, rail(-1, "base", false));
  }
  return settings(
    `${paneHead("Remote access", "Open Moss from your phone and laptop.")}
    ${group(
      "Addresses",
      `<div class="jds-empty"><span class="jds-empty__mark">${ic("globe")}</span><div class="jds-empty__title">Moss opens on this computer only</div><div class="jds-empty__sub">Reach it from your phone and laptop, at home or away.</div>${btn("Use Moss from other devices", "primary", { size: "md" })}</div>`
    )}`
  );
}

/* ---------- 2. Tailscale on this computer ---------- */

function tsScreen(s) {
  const disabledContinue = btn("Continue", "primary", { size: "md", disabled: true });
  const checkAgain = btn("Check again", "secondary", { icon: "refresh" });
  const run = `<code>sudo tailscale up</code>`;
  const map = {
    missing: [
      "Install Tailscale on this computer",
      "Tailscale joins your devices into a private network that only you can use.",
      `${group("Install on Linux", row("Install command", `<code>curl -fsSL https://tailscale.com/install.sh | sh</code>`, copyBtn()), { desc: `Run it in the terminal on ${MACHINE}.`, action: btn("Other systems", "quiet", { icon: "out" }) })}
      ${group("Then sign in", row("Sign-in command", run, copyBtn()), { desc: "Finish in the browser. Use the account you'll use on your phone." })}
      <div class="ra-line">${ind("Looking for Tailscale on this computer", "idle", true)}</div>
      ${actions(disabledContinue)}`,
    ],
    signedout: [
      "Sign in to Tailscale",
      "Tailscale is installed on this computer but isn't signed in.",
      `${group("Sign in", row("Sign-in command", run, copyBtn()), { desc: `Run it on ${MACHINE} and finish in the browser.`, action: ind("Signed out", "drift") })}
      <div class="ra-line">${checkAgain}</div>
      ${actions(disabledContinue)}`,
    ],
    expired: [
      "Sign in to Tailscale again",
      "This computer's Tailscale sign-in has expired.",
      `${group("Sign in again", row("Sign-in command", run, copyBtn()), { desc: `Run it on ${MACHINE}, or renew the sign-in on the Tailscale admin page.`, action: ind("Sign-in expired", "error") })}
      <div class="ra-line">${checkAgain}${btn("Open Tailscale admin", "quiet", { icon: "out" })}</div>
      ${actions(disabledContinue)}`,
    ],
    running: [
      "Tailscale is running on this computer",
      "",
      `${group(
        "This computer",
        row("Name", "", MACHINE) + row("Tailscale address", "", TSIP) + row("Signed in as", "", "jordan@example.com"),
        { action: ind("Connected", "ready"), desc: "Checked just now" }
      )}
      ${actions(btn("Continue", "primary", { size: "md" }))}`,
    ],
  };
  const [title, lede, body] = map[s || "missing"];
  return flow("ts", title, lede, body);
}

/* ---------- 3. Your phone and laptop ---------- */

function devScreen(s = "waiting") {
  const seen = s === "seen" || s === "two";
  let devices;
  if (seen)
    devices =
      row("iPhone", "Safari", ind("Opened Moss at 14:02", "ready")) +
      (s === "two" ? row("Laptop", "Firefox", ind("Opened Moss at 14:05", "ready")) : row("Waiting for another device", "", ind("Waiting", "idle", true)));
  else if (s === "stuck") devices = row("No device has opened it yet", "", ind("Waiting 6 minutes", "drift"));
  else devices = row("Waiting for a device", "", ind("Waiting", "idle", true));

  const stuck =
    s === "stuck"
      ? `<div class="gflow__card ra-block"><p class="gflow__title">If it won't open</p>${guide([
          "Open the Tailscale app on that device and check it says Connected.",
          `Sign in with the same account as ${MACHINE}.`,
          "Type the address yourself instead of scanning.",
        ])}</div>`
      : "";

  const body = `${group("Phone", `<div class="ra-qrrow">${qr(11)}<span class="gflow__links">${btn("App Store", "secondary", { icon: "out" })}${btn("Google Play", "secondary", { icon: "out" })}</span></div>`, { desc: "Scan to get Tailscale for iPhone or Android." })}
    ${group("Laptop", `<span class="gflow__links">${btn("Get Tailscale", "secondary", { icon: "out" })}</span>`, { desc: "Mac, Windows or Linux." })}
    ${group("Then open Moss on each device", `<div class="ra-qrrow">${qr(29)}</div>${row(`http://${TSIP}:1533`, "", copyBtn())}`)}
    ${group("Devices", devices)}
    ${stuck}
    ${actions(btn("Continue", "primary", { size: "md", disabled: !seen }), btn("Skip for now", "quiet", { size: "md" }))}`;
  return flow("devices", "Add your phone and laptop", "Install Tailscale on each device, sign in with the same account, then open the address.", body, {
    addrs: seen ? "ts" : "tspending",
  });
}

/* ---------- 4. Secure address ---------- */

function httpsScreen(s = "available") {
  const map = {
    available: [
      "Turn on a secure address",
      "Needed for the microphone, notifications and the Mac app.",
      `${group("Secure address", row(`https://${TSNAME}`, "From Tailscale", ind("Ready to turn on", "idle")))}
      ${actions(btn("Turn on", "primary", { size: "md" }), btn("Use a meetmoss.com name instead", "quiet", { size: "md" }))}`,
      "ts",
    ],
    checking: [
      "Turning on the secure address",
      "",
      `${group(
        "Progress",
        row("Get a certificate from Tailscale", "", ind("Done", "ready")) +
          row("Let Moss answer on the new address", "", ind("Done", "ready")) +
          row("Open it on another device", `https://${TSNAME}`, ctl(ind("Waiting", "idle", true), copyBtn()))
      )}
      ${actions(btn("Finish", "primary", { size: "md", disabled: true }))}`,
      "ts",
    ],
    done: [
      "You're set up",
      "",
      `${group("Addresses", row(`https://${TSNAME}`, "Secure", ind("Works", "ready")) + row(`http://${TSIP}:1533`, "Also works", ind("Works", "ready")), { desc: "Opened from iPhone at 14:10" })}
      ${group("Want a shorter name?", row(`Get an address like ${FULL}`, "", btn("Add a meetmoss.com name", "secondary")))}
      ${actions(btn("Finish", "primary", { size: "md" }))}`,
      "tsname",
    ],
    nohttps: [
      "A secure address isn't available yet",
      "Your Tailscale network has secure addresses switched off, so Tailscale can't give this computer one.",
      `${group("Get a meetmoss.com name", row(`A secure address like ${FULL}`, "Works whatever your Tailscale settings.", btn("Get a name", "primary")), { action: badge("Recommended", "forest") })}
      ${group("Switch it on in Tailscale", row("Turn on MagicDNS and HTTPS certificates", "In the Tailscale admin page, open DNS.", ctl(btn("Open Tailscale admin", "secondary", { icon: "out" }), btn("Check again", "quiet", { icon: "refresh" }))))}
      ${group("Use the plain address for now", row(`http://${TSIP}:1533`, "The microphone, notifications and the Mac app need a secure address.", btn("Finish without it", "quiet")))}`,
      "nohttps",
    ],
  };
  const [title, lede, body, addrs] = map[s];
  return flow("https", title, lede, body, { addrs });
}

/* ---------- 5. About the name ---------- */

function introScreen() {
  const body = `${group(
    FULL,
    row("Public", "Your name, this computer's Tailscale address, and the certificate for the name, which is listed in public logs for good.") +
      row("Private", "Everything in Moss. Only devices on your Tailscale network can open the name.") +
      row("Cost", "", "Free, one name per account") +
      row("Sign in with", "", "GitHub or Google") +
      row("Keeping it", "", "Renews by itself while Moss is running")
  )}
    ${actions(btn("Continue", "primary", { size: "md" }), btn("Not now", "quiet", { size: "md" }))}`;
  return flow("intro", "Add a meetmoss.com name", "", body, { addrs: "tsname" });
}

/* ---------- 6. Sign in ---------- */

function signinScreen(s = "choose") {
  const map = {
    choose: [
      "Sign in to meetmoss.com",
      "",
      `<div class="ra-signin">${btn("Sign in with GitHub", "secondary", { size: "md", icon: "out" })}${btn("Sign in with Google", "secondary", { size: "md", icon: "out" })}</div>
      ${actions(btn("Back", "quiet", { size: "md" }))}`,
    ],
    waiting: [
      "Finish signing in in your browser",
      "Moss opened a sign-in page. Check that it shows this code.",
      `${group("Sign-in code", row("KQ7-4WD", "", btn("Open the page again", "quiet", { icon: "out" })))}
      <div class="ra-line">${ind("Waiting for you to sign in", "idle", true)}</div>
      ${actions(btn("Cancel", "quiet", { size: "md" }))}`,
    ],
    invite: [
      "meetmoss.com names are invite-only for now",
      "Signed in as jordan-k on GitHub.",
      `${group(
        "Have an invite code?",
        field("Invite code", `<input class="jds-input" placeholder="MOSS-" aria-label="Invite code">${btn("Use code", "primary", { size: "md" })}`),
        { action: ind("Not on the list yet", "drift") }
      )}
      ${actions(btn("Ask for an invite", "secondary", { size: "md", icon: "out" }), btn("Use the Tailscale address for now", "quiet", { size: "md" }))}`,
    ],
    down: [
      "Can't reach meetmoss.com",
      "",
      `${note("alert", `meetmoss.com didn't answer. Last tried 14:20. Your Tailscale addresses aren't affected. ${btn("Try again", "secondary", { icon: "refresh" })}`)}
      ${actions(btn("Back", "quiet", { size: "md" }))}`,
    ],
    done: [
      "Signed in",
      "",
      `${group("Account", row("jordan-k", "GitHub", ctl(ind("Signed in", "ready"), btn("Use another account", "quiet"))))}
      ${actions(btn("Continue", "primary", { size: "md" }))}`,
    ],
  };
  const [title, lede, body] = map[s];
  return flow("signin", title, lede, body, { addrs: "tsname" });
}

/* ---------- 7. Pick a name ---------- */

function nameScreen(s = "free") {
  const cases = {
    empty: ["", "", ""],
    checking: ["jordank", "", ""],
    free: [NAME, `${FULL} is free`, ""],
    taken: ["jordan", "", "jordan.meetmoss.com is taken. Try one of these."],
    reserved: ["admin", "", "admin is reserved. Pick another."],
    short: ["jo", "", "Use 3 to 30 characters."],
    chars: ["jordan_k!", "", "Use letters, numbers and hyphens only."],
  };
  const [val, ok, error] = cases[s];
  const input = `<div class="ra-suffix"><input class="jds-input" value="${val}" placeholder="yourname" aria-label="Name"${error ? ' aria-invalid="true"' : ""}><span class="ra-suffix__text">.meetmoss.com</span></div>`;
  const status = s === "checking" ? ind("Checking", "idle", true) : ok ? ind(ok, "ready") : "";
  const sugg = s === "taken" ? `<div class="gflow__links">${["jordank", "jordan-home", "jordan-moss"].map((n) => btn(n, "chip")).join("")}</div>` : "";
  const body = `<div class="ra-block">${field("Name", input, { hint: "Every name is listed in public certificate logs, where it stays even after you release it.", error })}</div>
    ${status ? `<div class="ra-line">${status}</div>` : ""}${sugg ? `<div class="ra-line">${sugg}</div>` : ""}
    ${actions(btn("Register name", "primary", { size: "md", disabled: s !== "free" }), btn("Back", "quiet", { size: "md" }))}`;
  return flow("name", "Pick a name", "", body, { addrs: "tsname" });
}

/* ---------- 8. Network check ---------- */

function netScreen(s = "pass") {
  const here = s === "blocked" ? row("This computer", "Home router", ind("Blocked", "error")) : row("This computer", "Home router", ind(`Finds ${FULL}`, "ready"));
  const phone =
    s === "pending"
      ? row("iPhone", "", ctl(ind("Open the check page on it", "idle", true), copyBtn()))
      : row("iPhone", s === "blocked" ? "Mobile data" : "Home Wi-Fi", ind("Finds it", "ready"));
  const laptop =
    s === "blocked"
      ? row("Laptop", "Home Wi-Fi", ind("Blocked", "error"))
      : s === "pending"
        ? row("Laptop", "", ctl(ind("Not checked", "idle"), copyBtn()))
        : row("Laptop", "Home Wi-Fi", ind("Finds it", "ready"));
  const fix =
    s === "blocked"
      ? `<div class="gflow__card ra-block"><p class="gflow__title">Pi-hole on your network is blocking the name</p>${guide([
          "Open the Pi-hole admin page.",
          "Go to Settings, then DNS.",
          "Add <b>meetmoss.com</b> to the allowed rebind domains, then save.",
        ])}<div class="gflow__links">${btn("Check again", "secondary", { icon: "refresh" })}${btn("Use the Tailscale address instead", "quiet")}</div></div>`
      : "";
  const check = s === "pending" ? group("Check page", `<div class="ra-qrrow">${qr(41)}</div>${row(`https://${FULL}/check`, "", copyBtn())}`) : "";
  const title = s === "pass" ? "Every device can find your name" : s === "blocked" ? "Your network is blocking the name" : "Check each device";
  const body = `${group("Devices", here + phone + laptop)}${fix}${check}
    ${actions(btn("Continue", "primary", { size: "md", disabled: s !== "pass" }), btn("Add another device", "quiet", { size: "md" }))}`;
  return flow("net", title, "", body, { addrs: "tsname" });
}

/* ---------- 9. Certificate and switching on ---------- */

function certScreen(s = "working") {
  const done = ind("Done", "ready");
  const third = s === "working" ? ind("Usually under a minute", "idle", true) : s === "failed" ? ind("Didn't pass", "error") : done;
  const installed = s === "switch" || s === "done";
  const steps = group(
    "Progress",
    row("Ask Let's Encrypt for a certificate", "", done) +
      row("Prove the name is yours", "", done) +
      row("Let's Encrypt checks the proof", "", third) +
      row("Install the certificate", "", installed ? done : ind("Not started", "idle")) +
      row(
        "Open it on another device",
        s === "switch" ? `https://${FULL}` : "",
        s === "done" ? ind("iPhone at 14:31", "ready") : s === "switch" ? ctl(ind("Waiting", "idle", true), copyBtn()) : ind("Not started", "idle")
      )
  );
  const map = {
    working: ["Getting a certificate", `${steps}${actions(btn("Finish", "primary", { size: "md", disabled: true }))}`],
    failed: [
      "The certificate didn't come through",
      `${steps}<div class="ra-block">${note("alert", `Let's Encrypt couldn't see the proof record. It can take a few minutes to appear. ${btn("Try again", "secondary", { icon: "refresh" })}`)}</div>${actions(btn("Back", "quiet", { size: "md" }))}`,
    ],
    limit: [
      "Too many certificate requests",
      `${note("alert", "Let's Encrypt is limiting new certificates for this name. Moss tries again on 28 October at 16:40.")}${actions(btn("Finish later", "quiet", { size: "md" }))}`,
    ],
    down: [
      "Can't reach meetmoss.com",
      `${note("alert", `meetmoss.com didn't answer. Last tried 14:28. Moss tries again every 10 minutes. ${btn("Try now", "secondary", { icon: "refresh" })}`)}${actions(btn("Finish later", "quiet", { size: "md" }))}`,
    ],
    switch: [`Open ${FULL} on another device`, `${steps}${actions(btn("Finish", "primary", { size: "md", disabled: true }))}`],
    done: [
      `${FULL} is ready`,
      `${steps}${group("Certificate", row("Valid until", "", "25 January") + row("Renews on", "", "26 December"))}${actions(btn("Finish", "primary", { size: "md" }))}`,
    ],
  };
  const [title, body] = map[s];
  return flow("cert", title, "", body, { addrs: "tsname", nameDone: s === "done" });
}

/* ---------- 10. Settings, once set up ---------- */

function statusScreen(s = "all") {
  const hasName = s !== "tsonly";
  const addrRows = [
    hasName ? row(`https://${FULL}`, "meetmoss.com name. Certificate until 25 January, renews 26 December.", ctl(ind("Works", "ready"), copyBtn())) : "",
    row(`https://${TSNAME}`, "Tailscale", ctl(ind("Works", "ready"), copyBtn())),
    row(`http://${TSIP}:1533`, "Tailscale, plain. Not secure in the browser.", ctl(ind("Works", "ready"), copyBtn())),
  ].join("");

  const rename =
    s === "rename"
      ? row(
          "Change name",
          `${field(
            "New name",
            `<div class="ra-suffix"><input class="jds-input" value="jordan-home" aria-label="New name"><span class="ra-suffix__text">.meetmoss.com</span></div>`,
            { hint: `${FULL} stops working once the new name is ready.` }
          )}<div class="ra-line">${ind("jordan-home.meetmoss.com is free", "ready")}</div><div class="gflow__links ra-line">${btn("Change name", "primary")}${btn("Cancel", "quiet")}</div>`
        )
      : row("Change name", "The old name stops working once the new one is ready.", btn("Change name", "secondary"));

  const nameGroups = hasName
    ? group(
        "meetmoss.com name",
        row("Name", "", FULL) + row("Points to", "", `${TSIP}, updated today`) + row("Signed in as", "jordan-k on GitHub", btn("Sign out", "quiet")) + rename
      ) +
      group("Release name", row(`Release ${FULL}`, "It stops working on all your devices. Nobody else can take it for 30 days.", btn("Release name", "danger")), {
        danger: true,
      })
    : group("meetmoss.com name", row("Get a shorter secure address", `Like ${FULL}.`, btn("Add a name", "secondary")));

  const pane = `${paneHead("Remote access", "Open Moss from your phone and laptop.")}
    ${group("Addresses", addrRows, { desc: "All working. Checked today at 14:31.", action: btn("Check now", "secondary", { icon: "refresh" }) })}
    ${group(
      "Tailscale",
      row("This computer", "", MACHINE) +
        row("Tailscale address", "", TSIP) +
        row("Signed in as", "", "jordan@example.com") +
        row("Devices", "Add a phone or laptop to your Tailscale network.", btn("Add a device", "secondary")) +
        row("Tailscale admin", "", btn("Open", "quiet", { icon: "out" })),
      { action: ind("Connected", "ready") }
    )}
    ${nameGroups}
    ${s === "copied" ? toast("Address copied") : ""}`;

  const overlay =
    s === "release" ? dialog(`Release ${FULL}?`, "It stops working on all your devices now. Nobody else can take it for 30 days.", "Release name") : "";
  return settings(pane, { overlay });
}

/* ---------- 11. Alerts ---------- */

const ALERTS = {
  signedout: ["Tailscale is signed out on this computer", "Your phone and laptop can't reach Moss.", "Fix it", "Oct 27, 2026, 14:02"],
  addr: ["Tailscale address changed", `${FULL} couldn't be updated. Moss tries again in an hour.`, "Try again", "Oct 26, 2026, 09:15"],
  renew: ["Certificate didn't renew", `${FULL} runs out on 25 January. Moss keeps trying.`, "Details", "Oct 26, 2026, 03:00"],
  expired: ["Certificate ran out", `${FULL} stopped working. https://${TSNAME} still works.`, "Fix it", "Oct 25, 2026, 08:00"],
};

function alertScreen(s = "signedout") {
  if (s === "list") {
    const items = Object.values(ALERTS)
      .map(
        ([t, d, , when], i) =>
          `<article aria-busy="false"><div class="jds-index__row"><div class="jds-index__title"><span class="notifications-title">${ic("bell")}${t}</span></div><div class="jds-index__excerpt"><div class="notifications-body">${d}</div></div><div class="jds-index__meta"><span class="notifications-meta">${i < 2 ? "<span>Unread</span>" : ""}<span>${when}</span>${i < 2 ? `<button class="jds-iconbtn" type="button" title="Mark read" aria-label="Mark ${t} read">${ic("checkcheck")}</button>` : ""}</span></div></div></article>`
      )
      .join("");
    return app(
      `<section class="notifications-page"><section class="notifications-toolbar" aria-label="Notification filters"><div class="jds-segmented" role="group" aria-label="Read filter"><button type="button" class="jds-segmented__opt" aria-pressed="true">All (4)</button><button type="button" class="jds-segmented__opt" aria-pressed="false">Unread (2)</button></div>${btn("Mark all read", "secondary", { size: "md", icon: "checkcheck" })}</section><section><div class="jds-index jds-index--compact">${items}</div></section></section>`,
      { title: "Notifications" }
    );
  }
  const [t, d, action] = ALERTS[s];
  const pane = `${note("alert", `${t}. ${d} ${btn(action, "secondary")}`)}${paneHead("Remote access", "Open Moss from your phone and laptop.")}
    ${group(
      "Addresses",
      row(`https://${FULL}`, "meetmoss.com name", ind(s === "expired" ? "Stopped" : s === "renew" ? "Renewal failing" : s === "addr" ? "Out of date" : "Works", s === "expired" ? "error" : s === "signedout" ? "ready" : "drift")) +
        row(`https://${TSNAME}`, "Tailscale", ind(s === "signedout" ? "Can't be reached" : "Works", s === "signedout" ? "error" : "ready")),
      { action: btn("Check now", "secondary", { icon: "refresh" }) }
    )}`;
  return settings(pane);
}

/* ---------- 12. Moving a name from another Moss ---------- */

function moveScreen(s = "offer") {
  const where = group(FULL, row("Points to", "", "Another Moss, last seen 3 days ago") + row("Signed in as", "", "jordan-k on GitHub"));
  const steps = (moving) =>
    group(
      "Progress",
      row("Point the name at this computer", "", ind("Done", "ready")) +
        row("Check each device can find it", "", moving ? ind("Checking", "idle", true) : ind("Done", "ready")) +
        row("Get a certificate for this Moss", "", moving ? ind("Not started", "idle") : ind("Done", "ready")) +
        row("Open it on another device", "", moving ? ind("Not started", "idle") : ind("iPhone at 14:52", "ready"))
    );
  const offerBody = `${where}${actions(btn("Move it to this Moss", "primary", { size: "md" }), btn("Not now", "quiet", { size: "md" }))}`;
  const map = {
    offer: ["Your account already has a name", offerBody, ""],
    confirm: ["Your account already has a name", offerBody, dialog(`Move ${FULL} to this Moss?`, "It stops opening the other Moss straight away.", "Move name", false)],
    moving: [`Moving ${FULL}`, `${steps(true)}${actions(btn("Finish", "primary", { size: "md", disabled: true }))}`, ""],
    done: [
      `${FULL} now opens this Moss`,
      `${steps(false)}${group("Certificate", row("Valid until", "", "25 January") + row("Renews on", "", "26 December"))}${actions(btn("Finish", "primary", { size: "md" }))}`,
      "",
    ],
    failed: [
      "The name didn't move",
      `${note("alert", `meetmoss.com didn't answer. ${FULL} still points to the other Moss. ${btn("Try again", "secondary", { icon: "refresh" })}`)}${actions(btn("Back", "quiet", { size: "md" }))}`,
      "",
    ],
  };
  const [title, body, overlay] = map[s];
  return flow("name", title, "", body, { addrs: "tsname", nameDone: s === "done", overlay });
}

const RENDER = {
  m1: entry,
  m2: tsScreen,
  m3: devScreen,
  m4: httpsScreen,
  m5: introScreen,
  m6: signinScreen,
  m7: nameScreen,
  m8: netScreen,
  m9: certScreen,
  m10: statusScreen,
  m11: alertScreen,
  m12: moveScreen,
};
