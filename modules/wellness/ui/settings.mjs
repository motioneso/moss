import { moduleClient } from "./guest-bridge.mjs";
import { h, icon, button } from "./dom.mjs";

const LABEL = "Allow your assistant to read your wellness data";
const DESCRIPTION =
  "When on, your assistant can read your mood check-ins and medication adherence to reference them in briefings and answer questions about them. Counts only - never a medication list. Turn off anytime; your assistant will explain how to re-enable if asked.";
const INFO = '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>';

/** Calls the Wellness routes and turns every failure into an error that carries its status. */
export function wellnessApi(client) {
  return {
    async call(method, path, body) {
      let reply;
      try {
        reply = await client.request(method, path, body ?? null);
      } catch (error) {
        if (!Number.isInteger(error?.status)) throw error;
        reply = { status: error.status, body: error.body };
      }
      if (!(reply && typeof reply.status === "number" && "body" in reply)) {
        reply = { status: 200, body: reply };
      }
      if (reply.status >= 400) {
        const failure = new Error("Wellness request failed");
        failure.status = reply.status;
        throw failure;
      }
      return reply.body;
    }
  };
}

/** Draws the settings screen into `root`. `api.call` reads and saves the assistant access choice. */
export function renderSettings(root, { api }) {
  let consent = null;
  let loadFailed = false;
  let saving = false;
  let saveFailed = false;
  let run = 0;

  const head = h(
    "div",
    { class: "pane__head" },
    h("h1", { class: "pane__title" }, "Wellness"),
    h("p", { class: "pane__desc" }, "What your assistant can read from your Wellness data.")
  );
  const body = h("div", {});
  root.replaceChildren(head, body);

  async function load() {
    const mine = ++run;
    try {
      const reply = await api.call("GET", "/wellness/ai-consent");
      if (mine !== run) return;
      consent = reply;
      loadFailed = false;
    } catch {
      if (mine !== run) return;
      loadFailed = true;
    }
    paint();
  }

  async function choose(granted) {
    saving = true;
    saveFailed = false;
    run++; // A read that started before this write must not overwrite its answer.
    paint();
    try {
      consent = await api.call("PUT", "/wellness/ai-consent", { granted });
      loadFailed = false;
    } catch {
      saveFailed = true;
    }
    saving = false;
    paint();
  }

  const retry = (text) =>
    h(
      "div",
      { class: "wl-settings-status", role: "status" },
      h("span", {}, text),
      button("Try again", {
        variant: "secondary",
        size: "sm",
        onclick: () => {
          loadFailed = false;
          paint();
          void load();
        }
      })
    );

  function paint() {
    if (!consent) {
      body.replaceChildren(
        loadFailed
          ? retry("Could not load Wellness AI access.")
          : h("p", { role: "status" }, "Loading Wellness AI access…")
      );
      return;
    }
    const input = h("input", {
      type: "checkbox",
      "aria-label": LABEL,
      checked: consent.effective === true,
      disabled: saving
    });
    input.addEventListener("change", () => void choose(input.checked));
    const control = h(
      "div",
      { class: "set-row__control" },
      consent.explicit === null
        ? h("span", { class: "jds-badge jds-badge--neutral" }, "Inherited")
        : null,
      h(
        "label",
        { class: "jds-switch" },
        input,
        h("span", { class: "jds-switch__track" }, h("span", { class: "jds-switch__thumb" }))
      )
    );
    body.replaceChildren(
      ...[
        h(
          "section",
          { class: "pane__card" },
          h(
            "header",
            { class: "pane__cardhead" },
            h(
              "div",
              { class: "pane__cardheadmain" },
              h("h2", { class: "pane__cardtitle" }, "AI access")
            )
          ),
          h(
            "div",
            { class: "pane__cardbody" },
            h(
              "div",
              { class: "set-row" },
              h(
                "div",
                { class: "set-row__main" },
                h("div", { class: "set-row__name" }, LABEL),
                h("div", { class: "set-row__desc" }, DESCRIPTION)
              ),
              control
            )
          )
        ),
        loadFailed
          ? retry("Could not refresh Wellness AI access. Showing the last saved choice.")
          : null,
        saveFailed
          ? h(
              "div",
              { class: "wl-settings-status", role: "alert" },
              "Could not save Wellness AI access. Try again."
            )
          : null,
        h(
          "p",
          { class: "set2-note" },
          icon(INFO, { size: 13 }),
          h(
            "span",
            {},
            "Disabling this does not turn off the Wellness module itself - you'll still log check-ins and meds; your assistant just won't see them."
          )
        )
      ].filter(Boolean)
    );
  }

  paint();
  void load();
  return { load };
}

if (typeof document !== "undefined" && document.getElementById("root")) {
  const client = moduleClient();
  renderSettings(document.getElementById("root"), { api: wellnessApi(client) });
}
