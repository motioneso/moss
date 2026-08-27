import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type {
  GetNewsPersonalizationResponse,
  NewsCatalogResponse,
  NewsPersonalizationAvailabilityDto,
  NewsPrefsResponse
} from "@moss/shared";

import { ApiError } from "@moss/module-web-sdk";

import NewsSettings from "../../packages/news/src/settings/index.js";
import {
  NewsAddSourceError,
  previewOutcomeMessage,
  zipPreviewCandidates
} from "../../packages/news/src/settings/add-source.js";
import {
  describedTopicFormValues,
  describedTopicPendingMessage,
  describedTopicSuccessMessage,
  describedTopicUpdateInput,
  topicCreateErrorMessage
} from "../../packages/news/src/settings/describe-topics.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

// #953 Task 5: the personalization sections must never present a false affordance —
// custom-source/topic creation has NO write API in Slice 1, so its Add controls are visible
// but disabled regardless of prerequisites, while exclusion management is fully live.
// useQuery reads primed cache synchronously during renderToString (same harness as
// tests/unit/sports-page.test.tsx), so no fetch mocking is needed.

const catalog: NewsCatalogResponse = {
  sources: [
    {
      sourceKey: "bbc",
      label: "BBC News",
      homepageUrl: "https://www.bbc.com/news",
      defaultEnabled: true,
      topics: ["world"]
    },
    {
      sourceKey: "nytimes",
      label: "The New York Times",
      homepageUrl: "https://www.nytimes.com",
      defaultEnabled: false,
      topics: ["world"]
    }
  ],
  topics: [{ topicKey: "world", label: "World" }]
};

const prefs: NewsPrefsResponse = { prefs: [] };

const allOff: NewsPersonalizationAvailabilityDto = {
  aiConfigured: false,
  webSearchConfigured: false,
  customSourceByUrlEnabled: false,
  customSourceByNameEnabled: false,
  freeformTopicsEnabled: false
};

const allOn: NewsPersonalizationAvailabilityDto = {
  aiConfigured: true,
  webSearchConfigured: true,
  customSourceByUrlEnabled: true,
  customSourceByNameEnabled: true,
  freeformTopicsEnabled: true
};

function personalization(
  overrides: Partial<GetNewsPersonalizationResponse> = {}
): GetNewsPersonalizationResponse {
  return {
    availability: allOff,
    customSources: [],
    customTopics: [],
    sourceExclusions: [],
    snapshot: null,
    refresh: {
      state: "idle",
      updatedAt: null,
      lastRequestedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureKind: null
    },
    ...overrides
  };
}

/** A stored custom source in the given validation/health state (Task 9 Retry fixtures). */
function storedSource(
  validationStatus: "approved" | "needs_revalidation" | "rejected",
  healthStatus: "available" | "unavailable" = "available"
) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    label: "The Atlantic",
    canonicalDomain: "theatlantic.com",
    homepageUrl: "https://www.theatlantic.com",
    feedUrl: null,
    retrievalMethod: "scrape" as const,
    validationStatus,
    healthStatus,
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function storedTopic(validationStatus: "approved" | "needs_revalidation" | "rejected") {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    label: "Watches",
    guidance: null,
    validationStatus,
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function render(data: GetNewsPersonalizationResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(newsQueryKeys.catalog, catalog);
  client.setQueryData(newsQueryKeys.prefs, prefs);
  client.setQueryData(newsQueryKeys.personalization, data);
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(NewsSettings))
  );
}

function renderPersonalizationState(state: "pending" | "error"): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  client.setQueryData(newsQueryKeys.catalog, catalog);
  client.setQueryData(newsQueryKeys.prefs, prefs);
  const query = client.getQueryCache().build(client, {
    queryKey: newsQueryKeys.personalization,
    queryFn: async () => personalization()
  });
  if (state === "error") {
    query.setState({
      ...query.state,
      data: personalization(),
      dataUpdatedAt: Date.now(),
      error: new Error("boom"),
      fetchStatus: "idle",
      status: "error"
    });
  }
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(NewsSettings))
  );
}

describe("NewsSettings personalization sections (#953)", () => {
  it("renders all three new sections alongside the untouched curated controls", () => {
    const html = render(personalization());
    expect(html).toContain("Publications you add");
    expect(html).toContain("Topics across the web");
    expect(html).toContain("Excluded publishers");
    // Curated V1 controls unchanged.
    expect(html).toContain("BBC News");
    expect(html).toContain('aria-pressed="true"');
  });

  it("prerequisites missing: custom add controls are visible but disabled, with a setup link", () => {
    const html = render(personalization({ availability: allOff }));
    // Both closed-write Add buttons render disabled (@moss/ui Button, secondary/sm).
    expect(html).toContain('class="jds-btn jds-btn--secondary jds-btn--sm" disabled=""');
    expect(
      (html.match(/class="jds-btn jds-btn--secondary jds-btn--sm" disabled=""/g) ?? []).length
    ).toBe(2);
    expect(html).toContain("/settings?section=assistant");
    // The exclusion form stays fully live without any AI prerequisite.
    expect(html).toContain('class="jds-btn jds-btn--primary jds-btn--sm"');
    expect(html).not.toContain('class="jds-btn jds-btn--primary jds-btn--sm" disabled=""');
  });

  it("prerequisites met: add-source and add-topic forms are live (#975 Task 9 opens the writes)", () => {
    const html = render(personalization({ availability: allOn }));
    // The Slice-1 closed-write placeholders are gone — real forms render instead.
    expect(html).not.toContain("Coming soon");
    expect(html).toContain('id="nw-addsource-input"');
    expect(html).toContain('id="nw-addtopic-label"');
    // With prerequisites satisfied there is nothing to set up.
    expect(html).not.toContain("/settings?section=assistant");
  });

  it("renders stored verified sources and described topics read-only", () => {
    const html = render(
      personalization({
        availability: allOn,
        customSources: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            label: "The Atlantic",
            canonicalDomain: "theatlantic.com",
            homepageUrl: "https://www.theatlantic.com",
            feedUrl: null,
            retrievalMethod: "scrape",
            validationStatus: "approved",
            healthStatus: "available",
            createdAt: "2026-07-11T00:00:00.000Z"
          }
        ],
        customTopics: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            label: "Watches",
            guidance: "Mechanical watches and watchmaking; exclude smartwatches",
            validationStatus: "approved",
            createdAt: "2026-07-11T00:00:00.000Z"
          }
        ]
      })
    );
    expect(html).toContain("The Atlantic");
    expect(html).toContain("theatlantic.com");
    expect(html).toContain("Watches");
    expect(html).toContain("exclude smartwatches");
  });

  it("lists exclusions with per-row Remove actions and everywhere/neutral copy", () => {
    const html = render(
      personalization({
        sourceExclusions: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            canonicalDomain: "example.com",
            createdAt: "2026-07-11T00:00:00.000Z"
          }
        ]
      })
    );
    expect(html).toContain("example.com");
    expect(html).toContain('aria-label="Remove example.com"');
    // Spec copy: exclusions apply everywhere; removal returns the publisher to neutral.
    expect(html).toContain("never appear anywhere");
    expect(html).toContain("neutral");
  });

  it("renders an excluded curated tile as Excluded and disabled, never as On", () => {
    const html = render(
      personalization({
        sourceExclusions: [
          {
            id: "44444444-4444-4444-4444-444444444444",
            canonicalDomain: "bbc.com",
            createdAt: "2026-07-11T00:00:00.000Z"
          }
        ]
      })
    );
    expect(html).toContain("is-excluded");
    expect(html).toContain("Excluded</span>");
    // The other curated tile still shows its true On/Off state.
    expect(html).toContain('aria-pressed="false"');
  });
});

describe("NewsSettings described-topics section (#990)", () => {
  it("renames the section and explains the empty state honestly", () => {
    const html = render(personalization({ availability: allOn }));
    expect(html).toContain("Topics across the web");
    expect(html).toContain("News still uses your selected publications.");
  });

  it("renders an Edit affordance per stored topic alongside Remove", () => {
    const html = render(
      personalization({ availability: allOn, customTopics: [storedTopic("approved")] })
    );
    expect(html).toContain('aria-label="Edit Watches"');
    expect(html).toContain('aria-label="Remove Watches"');
  });

  it("escapes a hostile topic label in the Edit aria-label the same way Remove does", () => {
    const hostileTopic = {
      ...storedTopic("approved"),
      label: '<img src=x onerror=alert(1)>&lt;script&gt;"quoted'
    };
    const html = render(personalization({ availability: allOn, customTopics: [hostileTopic] }));
    expect(html).not.toContain("<img");
    expect(html).toMatch(/aria-label="Edit [^"]*&quot;quoted/);
  });

  it("shows authored personalization loading/error states without false topic UI", () => {
    const loading = renderPersonalizationState("pending");
    expect(loading).toContain("Loading personalized news settings");
    expect(loading).not.toContain("News still uses your selected publications.");
    expect(loading).not.toContain('id="nw-addtopic-label"');

    const error = renderPersonalizationState("error");
    expect(error).toContain("Could not load personalized news settings. Try again.");
    expect(error).not.toContain("News still uses your selected publications.");
    expect(error).not.toContain('id="nw-addtopic-label"');
  });
});

// #975 Task 9: the Slice-2/4 write APIs exist now, so Settings wires the scaffolds live —
// add-source preview/confirm, add-topic, per-row Remove, and a Retry validation button that
// enqueues owner-wide revalidation when any stored item needs attention.
describe("NewsSettings write flows (#975 Task 9)", () => {
  it("shows Remove buttons on stored source and topic rows", () => {
    const html = render(
      personalization({
        availability: allOn,
        customSources: [storedSource("approved")],
        customTopics: [storedTopic("approved")]
      })
    );
    expect(html).toContain('aria-label="Remove The Atlantic"');
    expect(html).toContain('aria-label="Remove Watches"');
  });

  it("keeps Remove available even when prerequisites are missing (deletes are never gated)", () => {
    const html = render(
      personalization({
        availability: allOff,
        customSources: [storedSource("approved")]
      })
    );
    expect(html).toContain('aria-label="Remove The Atlantic"');
  });

  it("shows Retry validation when a source needs revalidation", () => {
    const html = render(
      personalization({ availability: allOn, customSources: [storedSource("needs_revalidation")] })
    );
    expect(html).toContain("Retry validation");
  });

  it("shows Retry validation when an approved source is unavailable", () => {
    const html = render(
      personalization({
        availability: allOn,
        customSources: [storedSource("approved", "unavailable")]
      })
    );
    expect(html).toContain("Retry validation");
  });

  it("shows Retry validation when a described topic needs revalidation", () => {
    const html = render(
      personalization({ availability: allOn, customTopics: [storedTopic("needs_revalidation")] })
    );
    expect(html).toContain("Retry validation");
  });

  it("hides Retry validation when every stored item is approved and available", () => {
    const html = render(
      personalization({
        availability: allOn,
        customSources: [storedSource("approved")],
        customTopics: [storedTopic("approved")]
      })
    );
    expect(html).not.toContain("Retry validation");
  });
});

// Pure helpers behind the add flows — the interactive states (preview results, mutation
// errors) can't be reached through renderToString, so their copy mapping is tested directly.
describe("add-flow error/candidate helpers (#975 Task 9)", () => {
  it("maps preview failure statuses to fixed human copy, never echoing the machine key", () => {
    // Structured errors (prerequisite/transient/etc.) render via NewsAddSourceError instead —
    // this helper no longer guesses settings copy for "unavailable".
    expect(previewOutcomeMessage({ status: "unavailable" })).toBeNull();
    expect(previewOutcomeMessage({ status: "rejected", reason: "not_https" })).toContain("HTTPS");
    expect(previewOutcomeMessage({ status: "rejected", reason: "unreachable" })).toContain("reach");
    // Unknown reason keys fall back to generic copy instead of leaking the key.
    const unknown = previewOutcomeMessage({ status: "rejected", reason: "brand_new_reason" });
    expect(unknown).not.toContain("brand_new_reason");
    expect(previewOutcomeMessage({ status: "ok", confirmationId: "c1" })).toBeNull();
    expect(previewOutcomeMessage({ status: "ambiguous", confirmationId: "c1" })).toBeNull();
  });

  it("zips parallel candidate/candidateId arrays and drops entries without an id", () => {
    const candidate = {
      label: "The Atlantic",
      canonicalDomain: "theatlantic.com",
      homepageUrl: "https://www.theatlantic.com",
      retrievalMethod: "feed" as const,
      sampleCount: 5
    };
    const zipped = zipPreviewCandidates({
      status: "ambiguous",
      confirmationId: "c1",
      candidates: [candidate, { ...candidate, label: "Orphan" }],
      candidateIds: ["cand-1"]
    });
    expect(zipped).toHaveLength(1);
    expect(zipped[0]).toEqual({ candidate, candidateId: "cand-1" });
  });

  it("maps topic-create failures: 422 policy, 503 unavailable, server copy otherwise", () => {
    expect(topicCreateErrorMessage(new ApiError(422, "Topic is not allowed"))).toContain(
      "content policy"
    );
    expect(topicCreateErrorMessage(new ApiError(503, "unavailable"))).toContain("unavailable");
    expect(topicCreateErrorMessage(new ApiError(400, "Custom topic limit reached"))).toBe(
      "Custom topic limit reached"
    );
    expect(topicCreateErrorMessage(new Error("boom"))).toBe("Could not add that topic. Try again.");
  });
});

describe("NewsAddSourceError", () => {
  it("emits machine-readable prerequisite metadata without guessing a settings link", () => {
    const html = renderToString(
      createElement(NewsAddSourceError, {
        error: {
          code: "news.add_source.no_json_model",
          class: "prerequisite",
          remediationRef: "news.add_source.configure_json_model"
        }
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-jarvis-error-code="news.add_source.no_json_model"');
    expect(html).toContain('data-jarvis-error-class="prerequisite"');
    expect(html).not.toContain("Assistant settings");
  });

  it("omits the remediation attribute for a transient error with no remediationRef", () => {
    const html = renderToString(
      createElement(NewsAddSourceError, {
        error: { code: "news.add_source.discovery_unavailable", class: "transient" }
      })
    );
    expect(html).toContain('data-jarvis-error-class="transient"');
    expect(html).not.toContain("data-jarvis-error-remediation-ref");
  });
});

describe("describe-topics pure helpers (#990)", () => {
  it("keeps empty guidance in PATCH input so editing can clear it", () => {
    expect(describedTopicUpdateInput("t1", " Watches ", " ")).toEqual({
      id: "t1",
      label: "Watches",
      guidance: ""
    });
  });

  it("maps a stored topic to form field values, and null to the empty add-mode form", () => {
    expect(
      describedTopicFormValues({
        id: "t1",
        label: "Watches",
        guidance: "not smartwatches",
        validationStatus: "approved",
        createdAt: "2026-07-11T00:00:00.000Z"
      })
    ).toEqual({ label: "Watches", guidance: "not smartwatches" });
    expect(
      describedTopicFormValues({
        id: "t1",
        label: "Watches",
        guidance: null,
        validationStatus: "approved",
        createdAt: "2026-07-11T00:00:00.000Z"
      })
    ).toEqual({ label: "Watches", guidance: "" });
    expect(describedTopicFormValues(null)).toEqual({ label: "", guidance: "" });
  });

  it("gives create and edit distinct pending/success copy", () => {
    expect(describedTopicPendingMessage("create")).toBe("Checking topic…");
    expect(describedTopicPendingMessage("edit")).toBe("Saving changes…");
    expect(describedTopicSuccessMessage("create")).toBe("Topic added");
    expect(describedTopicSuccessMessage("edit")).toBe("Changes saved");
  });
});

// #975 council re-run, Req F: user/model-derived strings must render as inert TEXT. The
// settings pane has NO anchor derived from data — its only <a> anywhere under
// packages/news/src/settings/** is the static PrereqGate link (index.tsx, renders only when
// a prerequisite is missing) — so the strongest property holds and is asserted directly:
// hostile labels/guidance escape to literals, and hostile URLs can never become hrefs
// because no data-derived href exists at all.
describe("NewsSettings adversarial content renders as inert text (#975 council re-run)", () => {
  const adversarialSource = {
    ...storedSource("approved"),
    label: '<img src=x onerror=alert(1)>&lt;script&gt;"quoted',
    homepageUrl: "javascript:alert(document.cookie)",
    canonicalDomain: 'evil.example"'
  };
  const adversarialTopic = {
    ...storedTopic("approved"),
    label: "<script>alert(2)</script>",
    guidance: "data:text/html,<script>alert(3)</script>"
  };

  it("escapes hostile labels/guidance and renders zero anchors when prerequisites are met", () => {
    const html = render(
      personalization({
        availability: allOn,
        customSources: [adversarialSource],
        customTopics: [adversarialTopic]
      })
    );
    // No element injection of any kind — neither from the raw markup in the labels…
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    // …instead the hostile strings appear as escaped literal text…
    expect(html).toContain("&lt;img src=x onerror=");
    // …and pre-escaped entities in the input are double-escaped, proving there is no
    // decode-after-strip reordering that could revive `&lt;script&gt;` into markup.
    expect(html).toContain("&amp;lt;script&amp;gt;");
    // The label is interpolated into aria-label="Remove …": its raw quote must be
    // entity-escaped so it cannot break out of the attribute value.
    expect(html).toContain("&quot;quoted");
    // With prerequisites met the PrereqGate is absent, so the pane renders NO anchor at
    // all — the javascript:/data: URLs above can never become hrefs.
    expect(html).not.toContain("<a ");
  });

  it("only the static prereq link ever becomes an href, never a hostile scheme", () => {
    const html = render(
      personalization({
        availability: allOff,
        customSources: [adversarialSource],
        customTopics: [adversarialTopic]
      })
    );
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
    // Both PrereqGates (sources + topics sections) render under allOff; every href must be
    // the one static settings link and nothing else.
    expect(hrefs.length).toBeGreaterThan(0);
    expect([...new Set(hrefs)]).toEqual(["/settings?section=assistant"]);
    expect(hrefs.some((href) => /^(javascript|data):/i.test(href))).toBe(false);
  });
});
