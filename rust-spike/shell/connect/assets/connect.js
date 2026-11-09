// The app's own screens. Actions go to the app through window.ipc; the app answers by
// calling window.moss.show(state).
"use strict";

const post = (message) => window.ipc.postMessage(JSON.stringify(message));
const root = document.getElementById("screen");
let retryTimer = null;
let retryDelay = 2;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "onclick") node.addEventListener("click", value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

const button = (label, kind, onclick) =>
  el("button", { class: `jds-btn jds-btn--${kind}`, type: "button", onclick }, label);
const heading = (text) =>
  el("div", {}, el("p", { class: "jds-eyebrow" }, "Moss"), el("h1", {}, text));
const muted = (text) => el("p", { class: "connect-muted" }, text);
const back = (label, message) =>
  el(
    "button",
    { class: "jds-btn jds-btn--link connect-back", type: "button", onclick: () => post(message) },
    `← ${label}`
  );

function stopRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
}

const screens = {
  "first-run": () => [
    heading("Where does your Moss live?"),
    el(
      "div",
      { class: "connect-choices" },
      el(
        "button",
        { class: "connect-choice", type: "button", onclick: () => post({ do: "this-computer" }) },
        el("strong", {}, "This computer"),
        muted("Keep your Moss here.")
      ),
      el(
        "button",
        { class: "connect-choice", type: "button", onclick: () => post({ do: "another" }) },
        el("strong", {}, "Another computer"),
        muted("Connect to a Moss you already run.")
      )
    )
  ],

  add: (s) => {
    const input = el("input", {
      class: "jds-input",
      id: "address",
      name: "address",
      type: "text",
      inputmode: "url",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "https://192.168.1.20:5201"
    });
    input.value = s.address || "";
    const form = el(
      "form",
      { class: "auth-form" },
      el(
        "div",
        { class: "jds-field" },
        el("label", { class: "jds-label", for: "address" }, "Address"),
        input
      ),
      muted("Use an address from Sharing on that computer."),
      s.error ? el("p", { class: "connect-error", role: "alert" }, s.error) : "",
      el(
        "div",
        { class: "connect-actions" },
        el("button", { class: "jds-btn jds-btn--primary", type: "submit" }, "Continue")
      )
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      post({ do: "probe", address: input.value });
    });
    queueMicrotask(() => input.focus());
    return [
      back(s.first ? "Back" : "Servers", s.first ? { do: "first-run" } : { do: "servers" }),
      heading("Connect to another computer"),
      form
    ];
  },

  check: (s) => [
    back("Back", { do: "another", address: s.address }),
    heading(s.changed ? `${s.name} has a new certificate` : "Does this match?"),
    muted("Open Sharing on that computer and compare."),
    el("p", { class: "connect-code", id: "fingerprint" }, s.fingerprint),
    muted(s.address.replace("https://", "")),
    el(
      "div",
      { class: "connect-actions" },
      button("Cancel", "secondary", () =>
        post(s.changed ? { do: "servers" } : { do: "another", address: s.address })
      ),
      button("It matches", "primary", () =>
        post({
          do: s.changed ? "accept-new" : "confirm",
          id: s.id,
          address: s.address,
          fingerprint: s.fingerprint
        })
      )
    )
  ],

  connecting: (s) => [heading(s.name), muted("Connecting…")],

  problem: (s) => {
    const countdown = muted("");
    const nodes = [heading(`Can't reach ${s.name}`), el("p", { id: "reason" }, s.reason)];
    if (s.retry) {
      nodes.push(countdown);
      let left = retryDelay;
      const tick = () => {
        if (left <= 0) {
          retryDelay = Math.min(retryDelay * 2, 60);
          post({ do: "retry" });
          return;
        }
        countdown.textContent = `Trying again in ${left} second${left === 1 ? "" : "s"}.`;
        left -= 1;
        retryTimer = setTimeout(tick, 1000);
      };
      tick();
    }
    nodes.push(
      el(
        "div",
        { class: "connect-actions" },
        button(s.local ? "Start it" : "Try again", "primary", () => post({ do: "retry" })),
        button("Switch server", "secondary", () => post({ do: "servers" }))
      )
    );
    return nodes;
  },

  version: (s) => [
    heading(s.title),
    muted(s.detail),
    el(
      "div",
      { class: "connect-actions" },
      button("Switch server", "secondary", () => post({ do: "servers" }))
    )
  ],

  servers: (s) => [
    heading("Servers"),
    el(
      "ul",
      { class: "connect-servers" },
      ...s.servers.map((server) =>
        el(
          "li",
          { class: "connect-server" },
          el(
            "div",
            {},
            el("p", {}, el("strong", {}, server.name)),
            muted(`${server.detail} · ${server.state}`)
          ),
          el(
            "div",
            { class: "connect-actions" },
            server.removable
              ? button("Remove", "quiet", () => post({ do: "remove", id: server.id }))
              : "",
            button("Open", "secondary", () => post({ do: "open", id: server.id }))
          )
        )
      )
    ),
    el(
      "div",
      { class: "connect-actions" },
      button("Add another computer", "primary", () => post({ do: "another" }))
    )
  ]
};

window.moss = {
  show(state) {
    stopRetry();
    // A retry passes through "connecting", so only other screens reset the growing wait.
    if (state.screen !== "problem" && state.screen !== "connecting") retryDelay = 2;
    root.replaceChildren(...screens[state.screen](state));
    document.body.dataset.screen = state.screen;
    document.body.dataset.problem = state.code ?? "";
  }
};

post({ do: "start" });
