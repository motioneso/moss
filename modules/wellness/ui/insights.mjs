import { h, icon, PATHS, sectionHead, linkButton } from "./dom.mjs";

const ICONS = {
  Activity: PATHS.activity,
  Sun: PATHS.sun,
  CloudRain: PATHS.cloudRain,
  NotebookPen: PATHS.notebookPen,
  Pill: PATHS.pill
};
const TONES = new Set(["forest", "amber", "steel"]);

/** Draws the "Patterns in your check-ins" section into `root`.
 * `api.call(method, path, body)` returns the reply body. `onReviewNotes` runs when the person
 * follows an insight to their check-in notes. Returns `{ refresh }`. */
export function renderInsights(root, { api, onReviewNotes = () => {} }) {
  let run = 0;
  const body = h("div", { class: "wl-insights__body" });
  root.replaceChildren(
    h(
      "div",
      { class: "wl-insights" },
      sectionHead("02", "Patterns in your check-ins", "30 days"),
      body
    )
  );

  const line = (...content) => h("div", { class: "wl-insight" }, ...content);
  const quiet = (text, attrs = {}) => h("span", { class: "wl-subtle-text", ...attrs }, text);

  function show(insights) {
    if (insights.length === 0) {
      body.replaceChildren(
        line(quiet("Insights appear after about a week of check-ins. Keep going."))
      );
      return;
    }
    body.replaceChildren(
      ...insights.map((item) => {
        const tone = TONES.has(item.tone) ? item.tone : "steel";
        const main = h(
          "div",
          { class: "wl-insight__main" },
          h("div", { class: "wl-insight__tx" }, h("strong", {}, item.lead ?? ""), item.rest ?? "")
        );
        if (item.action === "review-notes") {
          main.append(
            h(
              "div",
              { class: "wl-insight__act" },
              linkButton(
                "Review those notes",
                onReviewNotes,
                icon(PATHS.arrowRight, { size: 13, stroke: 2.2 })
              )
            )
          );
        }
        return line(
          h(
            "span",
            { class: `wl-insight__ic wl-insight__ic--${tone}` },
            icon(Object.hasOwn(ICONS, item.icon) ? ICONS[item.icon] : PATHS.activity)
          ),
          main
        );
      })
    );
  }

  async function refresh() {
    const mine = ++run;
    body.replaceChildren(line(quiet("Loading insights…", { role: "status" })));
    try {
      const reply = await api.call("GET", "/wellness/insights");
      if (mine !== run) return;
      show(Array.isArray(reply?.insights) ? reply.insights : []);
    } catch {
      if (mine !== run) return;
      body.replaceChildren(
        line(
          quiet("Couldn't load insights. ", { role: "status" }),
          linkButton("Try again", refresh)
        )
      );
    }
  }

  void refresh();
  return { refresh };
}
