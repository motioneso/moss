/* global document */

import { moduleClient } from "./guest-bridge.mjs";
import { newsApi } from "./api.mjs";
import { h, button, badge, icon, note, PATHS } from "./dom.mjs";
import {
  ADD_SOURCE_GATE,
  curatedTileState,
  exclusionRejectionMessage,
  normalizePublisherDomain,
  planSourceToggle,
  planTopicToggle
} from "./domain.mjs";
import {
  gate,
  groupHead,
  newsIcon,
  section,
  sourceHealthBadge,
  failure,
  textRow
} from "./parts.mjs";
import { describedTopics } from "./topics.mjs";
import { addSourceFlow } from "./add-source.mjs";
import { storyPreferences } from "./feedback.mjs";

const REVALIDATION_REFETCH_DELAYS_MS = [2000, 6000, 15000];

/** Draws the News settings screen into `root`. */
export function renderSettings(
  root,
  { api, navigate = async () => {}, locale, timers = globalThis }
) {
  const state = {
    catalog: null,
    prefs: null,
    pers: null,
    prefsError: false,
    persError: false,
    loadingPrefs: true,
    loadingPers: true
  };
  let writing = false;
  let saved = false;
  let saveFailed = false;
  let addingSource = false;
  let revalidating = false;
  let revalidated = null; // "ok" | "error" | null
  let removingSourceId = null;
  let removeSourceFailed = false;
  let removingExclusionId = null;
  let removeExclusionFailed = false;
  let exclusionBusy = false;
  let exclusionInput = "";
  let exclusionError = null;

  const prefsNotice = h("div", {});
  const topicsGroups = h("div", {});
  const sourcesChips = h("div", {});
  const builtin = h("div", {});
  const mine = h("div", {});
  const addArea = h("div", {});
  const exclusionsArea = h("div", {});

  async function loadPrefs() {
    state.loadingPrefs = true;
    paintPrefs();
    try {
      const [catalog, prefs] = await Promise.all([api.catalog(), api.prefs()]);
      state.catalog = catalog;
      state.prefs = prefs.prefs ?? [];
      state.prefsError = false;
    } catch {
      state.prefsError = true;
    }
    state.loadingPrefs = false;
    paintPrefs();
  }

  async function loadPers() {
    try {
      state.pers = await api.personalization();
      state.persError = false;
    } catch {
      state.persError = true;
    }
    state.loadingPers = false;
    paintPers();
  }

  const refreshPers = async () => {
    await loadPers();
  };

  const prefsReady = () => state.catalog !== null && state.prefs !== null && !state.prefsError;

  async function mutatePreferences(ops) {
    if (writing || !prefsReady()) return;
    writing = true;
    saved = false;
    saveFailed = false;
    paintPrefs();
    try {
      // Sequential on purpose. The order matters (pin includes before adding the first).
      for (const op of ops) {
        if (op.op === "create") await api.createPref(op.kind, op.key);
        else await api.deletePref(op.id);
      }
      saved = true;
    } catch {
      saveFailed = true;
    }
    try {
      state.prefs = (await api.prefs()).prefs ?? [];
      state.prefsError = false;
    } catch {
      state.prefsError = true;
    }
    writing = false;
    paintPrefs();
  }

  async function revalidate() {
    if (revalidating) return;
    revalidating = true;
    revalidated = null;
    paintPers();
    try {
      await api.revalidate();
      revalidated = "ok";
      for (const delay of REVALIDATION_REFETCH_DELAYS_MS)
        timers.setTimeout(() => void loadPers(), delay);
    } catch {
      revalidated = "error";
    }
    revalidating = false;
    paintPers();
  }

  const retryRow = () =>
    h(
      "div",
      { class: "nw-set__addrow" },
      button(revalidating ? "Queuing…" : "Retry validation", {
        variant: "secondary",
        size: "sm",
        disabled: revalidating,
        onClick: () => void revalidate()
      }),
      revalidated === "ok"
        ? h(
            "span",
            { class: "nw-set__gate", role: "status" },
            "Revalidation queued — statuses update after the next check."
          )
        : null,
      revalidated === "error"
        ? h(
            "span",
            { class: "nw-set__exerr", role: "alert" },
            "Could not queue revalidation. Try again."
          )
        : null
    );

  const topics = describedTopics({ api, navigate, state, refresh: refreshPers, retryRow });
  const addFlow = addSourceFlow({ api, refresh: refreshPers });
  const feedback = storyPreferences({ api, refreshOverview: async () => {}, locale });

  function paintPrefs() {
    const pending = !prefsReady() || writing;
    prefsNotice.replaceChildren(
      !prefsReady()
        ? h(
            "p",
            { class: "nw-set__hint", role: "status" },
            state.prefsError
              ? "Could not load your saved preferences. Source and topic choices are unavailable."
              : "Loading your saved preferences…",
            " ",
            state.prefsError
              ? button("Retry preferences", {
                  variant: "quiet",
                  size: "sm",
                  disabled: state.loadingPrefs,
                  onClick: () => void loadPrefs()
                })
              : null
          )
        : null,
      writing ? h("p", { role: "status" }, "Saving preferences…") : null,
      saved && !writing ? h("p", { role: "status" }, "Preferences saved.") : null,
      saveFailed
        ? h(
            "p",
            { class: "nw-set__exerr", role: "alert" },
            "Could not save all preferences. Some changes may have saved; check the loaded choices before trying again."
          )
        : null
    );
    const followed = new Set(
      (state.prefs ?? []).filter((pref) => pref.kind === "topic").map((pref) => pref.key)
    );
    const catalogTopics = state.catalog?.topics ?? [];
    sourcesChips.replaceChildren(
      groupHead("Topics from your sources", catalogTopics.length),
      h(
        "p",
        { class: "nw-set__hint" },
        "Narrow your enabled sources to these desks. With none followed you get each source’s general front page."
      ),
      h(
        "div",
        { class: "nw-set__chips" },
        catalogTopics.map((topic) => {
          const active = prefsReady() && followed.has(topic.topicKey);
          return h(
            "button",
            {
              type: "button",
              class: `nw-settopic${active ? " is-active" : ""}`,
              disabled: pending,
              "aria-pressed": prefsReady() ? String(active) : null,
              onClick: () => void mutatePreferences(planTopicToggle(topic.topicKey, state.prefs))
            },
            topic.label
          );
        })
      )
    );
    paintBuiltin();
  }

  function paintBuiltin() {
    const sources = state.catalog?.sources ?? [];
    const exclusions = state.pers?.sourceExclusions ?? [];
    const excludedDomains = exclusions.map((entry) => entry.canonicalDomain);
    const ready = prefsReady();
    const pending = !ready || writing;
    const states = new Map(
      ready
        ? sources.map((s) => [s.sourceKey, curatedTileState(s, state.prefs, excludedDomains)])
        : []
    );
    const enabled = sources.filter((s) => states.get(s.sourceKey) === "on").length;
    const anyExcluded = sources.some((s) => states.get(s.sourceKey) === "excluded");
    builtin.replaceChildren(
      groupHead("Built-in sources", sources.length),
      h(
        "div",
        { class: "nw-set__grid" },
        sources.map((source) => {
          const tile = states.get(source.sourceKey) ?? "off";
          const excluded = tile === "excluded";
          const active = tile === "on";
          return h(
            "button",
            {
              type: "button",
              class: `nw-setsrc${active ? " is-active" : ""}${excluded ? " is-excluded" : ""}`,
              disabled: pending || excluded,
              "aria-pressed": ready ? String(active) : null,
              onClick: () =>
                void mutatePreferences(planSourceToggle(source.sourceKey, sources, state.prefs))
            },
            h("span", { class: "nw-setsrc__name" }, source.label),
            h(
              "span",
              { class: "nw-setsrc__state" },
              !ready
                ? state.prefsError
                  ? "Unavailable"
                  : "Loading…"
                : excluded
                  ? "Excluded"
                  : active
                    ? "On"
                    : "Off"
            )
          );
        })
      ),
      anyExcluded
        ? note(
            "Excluded publishers override these toggles — manage them under Excluded publishers below."
          )
        : null,
      ready && !pending && enabled === 0
        ? note("No sources enabled — your News page will be empty until you turn one on.")
        : null
    );
  }

  async function removeSource(source) {
    removingSourceId = source.id;
    removeSourceFailed = false;
    paintPers();
    try {
      await api.removeSource(source.id);
      await refreshPers();
    } catch {
      removeSourceFailed = true;
    }
    removingSourceId = null;
    paintPers();
  }

  function sourceRow(source) {
    const unhealthy = source.validationStatus !== "approved" || source.healthStatus !== "healthy";
    return h(
      "li",
      { class: "nw-set__item" },
      h(
        "div",
        { class: "nw-set__item-row" },
        h(
          "div",
          { class: "nw-set__identity" },
          newsIcon(),
          h("span", { class: "nw-set__item-label" }, source.label),
          h("span", { class: "nw-set__item-meta" }, source.canonicalDomain),
          sourceHealthBadge(source)
        ),
        h(
          "div",
          { class: "nw-set__actions" },
          unhealthy
            ? button(revalidating ? "Queuing…" : "Retry", {
                variant: "secondary",
                size: "sm",
                "aria-label": `Retry ${source.label}`,
                disabled: revalidating,
                onClick: () => void revalidate()
              })
            : null,
          button("Remove", {
            variant: "secondary",
            size: "sm",
            "aria-label": `Remove ${source.label}`,
            disabled: removingSourceId === source.id,
            onClick: () => void removeSource(source)
          })
        )
      )
    );
  }

  async function submitExclusion() {
    const normalized = normalizePublisherDomain(exclusionInput);
    if (!normalized.ok) {
      exclusionError = exclusionRejectionMessage(normalized.reason);
      paintExclusions();
      return;
    }
    exclusionError = null;
    exclusionBusy = true;
    paintExclusions();
    try {
      await api.addExclusion(exclusionInput.trim());
      exclusionInput = "";
      await refreshPers();
    } catch (caught) {
      exclusionError =
        caught?.status && caught.message !== "News request failed"
          ? caught.message
          : "Could not exclude that publisher.";
    }
    exclusionBusy = false;
    paintExclusions();
  }

  async function removeExclusion(entry) {
    removingExclusionId = entry.id;
    removeExclusionFailed = false;
    paintExclusions();
    try {
      await api.removeExclusion(entry.id);
      await refreshPers();
    } catch {
      removeExclusionFailed = true;
    }
    removingExclusionId = null;
    paintExclusions();
  }

  function paintExclusions() {
    const ready = state.pers !== null;
    const exclusions = state.pers?.sourceExclusions ?? [];
    const add = button("Add", { size: "sm", type: "submit", disabled: exclusionBusy });
    const row = textRow({
      id: "nw-exclusion-input",
      label: "Publisher domain or HTTPS link",
      value: exclusionInput,
      placeholder: "example.com",
      disabled: exclusionBusy,
      onInput: (value) => {
        exclusionInput = value;
        exclusionError = null;
      },
      buttons: [add]
    });
    exclusionsArea.replaceChildren(
      groupHead("Excluded publishers", exclusions.length || null),
      h(
        "p",
        { class: "nw-set__hint" },
        "Excluded publishers never appear anywhere in News, Today, or briefings. Removing one returns it to neutral."
      ),
      ready
        ? h(
            "form",
            {
              class: "nw-set__exform",
              onSubmit: (event) => {
                event.preventDefault();
                void submitExclusion();
              }
            },
            ...row.nodes
          )
        : null,
      ready && exclusionError ? failure(exclusionError) : null,
      ready && exclusions.length > 0
        ? h(
            "ul",
            { class: "nw-set__list" },
            exclusions.map((entry) =>
              h(
                "li",
                { class: "nw-set__item" },
                h(
                  "div",
                  { class: "nw-set__item-row" },
                  h("span", { class: "nw-set__item-label" }, entry.canonicalDomain),
                  h(
                    "div",
                    { class: "nw-set__actions" },
                    button("Remove", {
                      variant: "secondary",
                      size: "sm",
                      "aria-label": `Remove ${entry.canonicalDomain}`,
                      disabled: removingExclusionId === entry.id,
                      onClick: () => void removeExclusion(entry)
                    })
                  )
                )
              )
            )
          )
        : null,
      ready && removeExclusionFailed ? note("Could not remove that exclusion. Try again.") : null
    );
  }

  function paintAddArea() {
    const availability = state.pers?.availability ?? null;
    const enabled = availability?.customSourceByUrlEnabled === true;
    const disabledRow = () =>
      h(
        "div",
        { class: "nw-set__addrow" },
        button("Add source", { variant: "secondary", size: "sm", disabled: true }),
        availability ? gate(ADD_SOURCE_GATE, navigate) : null
      );
    addArea.replaceChildren(
      h(
        "div",
        { class: "nw-set__add-section" },
        addingSource
          ? [
              h(
                "div",
                { class: "nw-set__add-head" },
                h("h3", { class: "nw-set__subheading" }, "Add a source"),
                button("Close", {
                  variant: "secondary",
                  size: "sm",
                  "aria-expanded": "true",
                  onClick: () => {
                    addingSource = false;
                    paintAddArea();
                  }
                })
              ),
              enabled ? addFlow.el : disabledRow()
            ]
          : enabled
            ? button([icon(PATHS.plus, 14), "Add a source"], {
                variant: "secondary",
                size: "sm",
                "aria-expanded": "false",
                onClick: () => {
                  addingSource = true;
                  paintAddArea();
                }
              })
            : disabledRow()
      )
    );
  }

  function paintPers() {
    const availability = state.pers?.availability ?? null;
    const ready = state.pers !== null;
    const customSources = state.pers?.customSources ?? [];
    const customTopics = state.pers?.customTopics ?? [];
    const sourcesNeedAttention = customSources.some(
      (s) => s.validationStatus !== "approved" || s.healthStatus !== "healthy"
    );
    topicsGroups.replaceChildren(
      h(
        "div",
        { class: "nw-set__group" },
        groupHead("Topics across the web", customTopics.length || null),
        h(
          "p",
          { class: "nw-set__hint" },
          "Freeform topics in your own words, including guidance on what to include or leave out."
        ),
        availability
          ? h(
              "p",
              { class: "nw-set__prereq" },
              badge(
                `AI model ${availability.aiConfigured ? "ready" : "needed"}`,
                availability.aiConfigured ? "pine" : "amber",
                { dot: true }
              ),
              badge(
                `Web search ${availability.webSearchConfigured ? "ready" : "needed"}`,
                availability.webSearchConfigured ? "pine" : "amber",
                { dot: true }
              )
            )
          : null,
        state.persError ? failure("Could not load personalized news settings. Try again.") : null,
        ready ? topics.el : null
      )
    );
    if (ready) topics.paint();
    mine.replaceChildren(
      state.loadingPers ? note("Loading personalized news settings…") : null,
      state.persError ? note("Could not load personalized news settings. Try again.") : null,
      ready && customSources.length > 0
        ? h(
            "div",
            { class: "nw-set__group" },
            groupHead("Sources you add", customSources.length),
            h(
              "p",
              { class: "nw-set__hint" },
              "Sources you add yourself, verified before they join your feed. Verified sources contribute recent headlines to News and briefings."
            ),
            availability
              ? h(
                  "p",
                  { class: "nw-set__prereq" },
                  badge(
                    `AI model ${availability.aiConfigured ? "ready" : "needed"}`,
                    availability.aiConfigured ? "pine" : "amber",
                    { dot: true }
                  )
                )
              : null,
            h("ul", { class: "nw-set__list" }, customSources.map(sourceRow))
          )
        : null,
      ready && removeSourceFailed ? note("Could not remove that source. Try again.") : null,
      sourcesNeedAttention && revalidated === "ok"
        ? h(
            "span",
            { class: "nw-set__gate", role: "status" },
            "Revalidation queued — statuses update after the next check."
          )
        : null,
      sourcesNeedAttention && revalidated === "error"
        ? h(
            "span",
            { class: "nw-set__exerr", role: "alert" },
            "Could not queue revalidation. Try again."
          )
        : null
    );
    paintAddArea();
    paintExclusions();
    paintBuiltin();
  }

  root.replaceChildren(
    h(
      "div",
      { class: "pane__head" },
      h("h1", { class: "pane__title" }, "News"),
      h(
        "p",
        { class: "pane__desc" },
        "Pick the sources your front page draws from, and optionally narrow it to the topics you follow. These choices also shape news in briefings."
      )
    ),
    prefsNotice,
    section(
      "Topics",
      "Topics",
      "Follow desks from your sources or describe interests and exclusions across the web.",
      h("div", { class: "nw-set__group" }, sourcesChips),
      topicsGroups
    ),
    section(
      "Publishers",
      "Publishers",
      "Choose built-in sources, add your own, or exclude domains.",
      h("div", { class: "nw-set__group" }, builtin),
      mine,
      addArea,
      h("div", { class: "nw-set__group" }, exclusionsArea)
    ),
    feedback.el
  );

  paintPrefs();
  paintPers();
  void loadPrefs();
  void loadPers();
  void feedback.load();
  return { loadPrefs, loadPers };
}

if (typeof document !== "undefined" && document.getElementById("root")) {
  const client = moduleClient();
  renderSettings(document.getElementById("root"), {
    api: newsApi(client),
    navigate: (path) => client.navigate(path),
    locale: globalThis.navigator?.language
  });
}
