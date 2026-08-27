import { expect, test } from "@playwright/test";

import { mockApi } from "./mock-api.js";

// #990: local stateful mock for News Settings — proves the described-topic add/edit/remove
// round-trip through the real PATCH client wrapper (Task 1) and the extracted DescribeTopics
// component (Task 3). Deliberately not a shared tests/e2e/mock-*.ts helper (spec is explicit
// this stays local to this file). No live web-search/model/RSS/worker.

const NEWS_MODULE = {
  id: "news",
  name: "News",
  version: "0.1.0",
  lifecycle: "user-toggleable" as const,
  navigation: [{ id: "news", label: "News", path: "/news", icon: "newspaper", order: 34 }],
  settings: []
};

test.beforeEach(async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });

  await page.route("**/api/modules", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ modules: [NEWS_MODULE] })
    })
  );
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        modules: [
          {
            ...NEWS_MODULE,
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true
          }
        ]
      })
    })
  );

  await page.route("**/api/news/catalog", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: [
          {
            sourceKey: "bbc",
            label: "BBC News",
            homepageUrl: "https://www.bbc.com/news",
            defaultEnabled: true,
            topics: ["world"]
          }
        ],
        topics: [{ topicKey: "world", label: "World" }]
      })
    })
  );
  await page.route("**/api/news/prefs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ prefs: [] })
    })
  );

  let customTopics: Array<{
    id: string;
    label: string;
    guidance: string | null;
    validationStatus: "approved" | "needs_revalidation" | "rejected";
    createdAt: string;
  }> = [];

  await page.route("**/api/news/personalization", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        availability: {
          aiConfigured: true,
          webSearchConfigured: true,
          customSourceByUrlEnabled: true,
          customSourceByNameEnabled: true,
          freeformTopicsEnabled: true
        },
        customSources: [],
        customTopics,
        sourceExclusions: [],
        snapshot: null,
        refresh: { state: "idle", updatedAt: null }
      })
    })
  );

  await page.route("**/api/news/topics", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { label: string; guidance?: string };
    const topic = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      label: body.label,
      guidance: body.guidance ?? null,
      validationStatus: "approved" as const,
      createdAt: "2026-07-12T00:00:00.000Z"
    };
    customTopics = [...customTopics, topic];
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ topic })
    });
  });

  await page.route("**/api/news/topics/*", (route) => {
    const method = route.request().method();
    const id = route.request().url().split("/").pop();
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as { label?: string; guidance?: string };
      customTopics = customTopics.map((topic) =>
        topic.id === id
          ? {
              ...topic,
              label: body.label ?? topic.label,
              guidance: body.guidance ?? topic.guidance
            }
          : topic
      );
      const updated = customTopics.find((topic) => topic.id === id)!;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ topic: updated })
      });
    }
    if (method === "DELETE") {
      customTopics = customTopics.filter((topic) => topic.id !== id);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted: true })
      });
    }
    return route.continue();
  });

  // #2008: every test in this file now renders the publications list, which asks which
  // sources have a key. Default: none, so nothing about keys appears anywhere.
  await page.route("**/api/news/credentials", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ credentials: [] })
    })
  );

  await page.route("**/api/news/revalidation", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ queued: true })
    })
  );
});

test("described topics: empty state, create via Enter, edit, and remove", async ({ page }) => {
  await page.goto("/settings?section=modules&module=news");
  await expect(page.getByRole("heading", { name: "News" })).toBeVisible();
  await expect(page.getByText("Topics across the web")).toBeVisible();
  await expect(page.getByText("News still uses your selected publications.")).toBeVisible();

  // Create via Enter from the label input (no explicit button click).
  const labelInput = page.getByLabel("Topic in your own words");
  const guidanceInput = page.getByLabel("Optional guidance — what to include or leave out");
  await labelInput.fill("Watches");
  await guidanceInput.fill("not smartwatches");
  const [createRequest] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/news/topics") && r.method() === "POST"),
    labelInput.press("Enter")
  ]);
  expect(createRequest.postDataJSON()).toEqual({ label: "Watches", guidance: "not smartwatches" });
  await expect(page.getByRole("status")).toContainText("Topic added");
  await expect(page.getByText("Watches", { exact: true })).toBeVisible();
  await expect(page.getByText("not smartwatches", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const savedGuidance = page.getByText("not smartwatches", { exact: true });
  await expect(savedGuidance).toBeVisible();
  expect(
    await savedGuidance.evaluate((node) => ({
      overflow: getComputedStyle(node).overflow,
      whiteSpace: getComputedStyle(node).whiteSpace
    }))
  ).toEqual({ overflow: "visible", whiteSpace: "normal" });
  await expect(page.getByRole("button", { name: "Edit Watches" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Watches" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });

  // Edit loads the form and PATCHes on save.
  await page.getByRole("button", { name: "Edit Watches" }).click();
  await expect(labelInput).toHaveValue("Watches");
  await expect(guidanceInput).toHaveValue("not smartwatches");
  await guidanceInput.fill("mechanical only");
  const [updateRequest] = await Promise.all([
    page.waitForRequest((r) => /\/api\/news\/topics\/.+/.test(r.url()) && r.method() === "PATCH"),
    page.getByRole("button", { name: "Save changes" }).click()
  ]);
  expect(updateRequest.postDataJSON()).toMatchObject({ guidance: "mechanical only" });
  await expect(page.getByRole("status")).toContainText("Changes saved");
  await expect(page.getByText("mechanical only")).toBeVisible();

  // Empty guidance remains explicit in PATCH so stored guidance can be cleared.
  await page.getByRole("button", { name: "Edit Watches" }).click();
  await guidanceInput.fill("");
  const [clearGuidanceRequest] = await Promise.all([
    page.waitForRequest((r) => /\/api\/news\/topics\/.+/.test(r.url()) && r.method() === "PATCH"),
    page.getByRole("button", { name: "Save changes" }).click()
  ]);
  expect(clearGuidanceRequest.postDataJSON()).toEqual({ label: "Watches", guidance: "" });
  await expect(page.getByRole("status")).toContainText("Changes saved");
  await expect(page.getByText("mechanical only", { exact: true })).toHaveCount(0);

  // Remove returns to the honest empty state.
  const [deleteRequest] = await Promise.all([
    page.waitForRequest((r) => /\/api\/news\/topics\/.+/.test(r.url()) && r.method() === "DELETE"),
    page.getByRole("button", { name: "Remove Watches" }).click()
  ]);
  expect(deleteRequest.method()).toBe("DELETE");
  await expect(page.getByRole("status")).toContainText("Topic removed");
  await expect(page.getByText("News still uses your selected publications.")).toBeVisible();
});

test("topic success waits for the refreshed row before announcing completion", async ({ page }) => {
  let topicCreated = false;
  let releaseRefetch!: () => void;
  let markRefetchStarted!: () => void;
  const refetchGate = new Promise<void>((resolve) => {
    releaseRefetch = resolve;
  });
  const refetchStarted = new Promise<void>((resolve) => {
    markRefetchStarted = resolve;
  });

  await page.route("**/api/news/personalization", async (route) => {
    if (topicCreated) {
      markRefetchStarted();
      await refetchGate;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        availability: {
          aiConfigured: true,
          webSearchConfigured: true,
          customSourceByUrlEnabled: true,
          customSourceByNameEnabled: true,
          freeformTopicsEnabled: true
        },
        customSources: [],
        customTopics: topicCreated
          ? [
              {
                id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
                label: "Watches",
                guidance: "mechanical only",
                validationStatus: "approved",
                createdAt: "2026-07-12T00:00:00.000Z"
              }
            ]
          : [],
        sourceExclusions: [],
        snapshot: null,
        refresh: { state: "idle", updatedAt: null }
      })
    });
  });
  await page.route("**/api/news/topics", (route) => {
    topicCreated = true;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        topic: {
          id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          label: "Watches",
          guidance: "mechanical only",
          validationStatus: "approved",
          createdAt: "2026-07-12T00:00:00.000Z"
        }
      })
    });
  });

  await page.goto("/settings?section=modules&module=news");
  const labelInput = page.getByLabel("Topic in your own words");
  await labelInput.fill("Watches");
  await page.getByLabel("Optional guidance — what to include or leave out").fill("mechanical only");
  await labelInput.press("Enter");
  await refetchStarted;
  await expect(page.getByRole("status")).toContainText("Checking topic…");
  await expect(page.getByText("Topic added", { exact: true })).toHaveCount(0);

  releaseRefetch();
  await expect(page.getByText("Watches", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Topic added");
});

test("create and edit errors stay local when switching modes or canceling", async ({ page }) => {
  await page.route("**/api/news/personalization", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        availability: {
          aiConfigured: true,
          webSearchConfigured: true,
          customSourceByUrlEnabled: true,
          customSourceByNameEnabled: true,
          freeformTopicsEnabled: true
        },
        customSources: [],
        customTopics: [
          {
            id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            label: "Politics",
            guidance: null,
            validationStatus: "approved",
            createdAt: "2026-07-12T00:00:00.000Z"
          }
        ],
        sourceExclusions: [],
        snapshot: null,
        refresh: { state: "idle", updatedAt: null }
      })
    })
  );
  await page.route("**/api/news/topics", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ message: "Topic is not allowed" })
    });
  });
  await page.route("**/api/news/topics/*", (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    return route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ message: "Topic is not allowed" })
    });
  });

  await page.goto("/settings?section=modules&module=news");
  await expect(page.getByRole("heading", { name: "News" })).toBeVisible();

  const labelInput = page.getByLabel("Topic in your own words");

  // Failed create retains input, then entering edit clears create-only feedback.
  await labelInput.fill("Banned topic");
  await labelInput.press("Enter");
  await expect(page.getByRole("alert")).toContainText("content policy");
  await expect(labelInput).toHaveValue("Banned topic");
  await page.getByRole("button", { name: "Edit Politics" }).click();
  await expect(labelInput).toHaveValue("Politics");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Failed edit stays in edit mode, then Cancel clears edit-only feedback in add mode.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("content policy");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(labelInput).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("retry validation queues owner-wide revalidation and surfaces queued/error feedback", async ({
  page
}) => {
  // Acceptance coverage only for the EXISTING shared retryRow/revalidateMutation — this test
  // adds no unit coverage and changes no shared code. It only proves, through the real
  // control, what the approved spec's acceptance checklist requires.
  await page.route("**/api/news/personalization", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        availability: {
          aiConfigured: true,
          webSearchConfigured: true,
          customSourceByUrlEnabled: true,
          customSourceByNameEnabled: true,
          freeformTopicsEnabled: true
        },
        customSources: [],
        customTopics: [
          {
            id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
            label: "Elections",
            guidance: null,
            validationStatus: "needs_revalidation",
            createdAt: "2026-07-12T00:00:00.000Z"
          }
        ],
        sourceExclusions: [],
        snapshot: null,
        refresh: { state: "idle", updatedAt: null }
      })
    })
  );

  let revalidationCalls = 0;
  await page.route("**/api/news/revalidation", (route) => {
    revalidationCalls += 1;
    if (revalidationCalls === 1) {
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ queued: true })
      });
    }
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "revalidation failed" })
    });
  });

  await page.goto("/settings?section=modules&module=news");
  await expect(page.getByRole("heading", { name: "News" })).toBeVisible();

  const retryButton = page.getByRole("button", { name: "Retry validation" });
  await expect(retryButton).toBeVisible();

  const [firstRequest] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/news/revalidation") && r.method() === "POST"),
    retryButton.click()
  ]);
  expect(firstRequest.method()).toBe("POST");
  await expect(page.getByRole("status")).toContainText(
    "Revalidation queued — statuses update after the next check."
  );

  await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/news/revalidation") && r.method() === "POST"),
    retryButton.click()
  ]);
  await expect(page.getByRole("alert")).toContainText("Could not queue revalidation. Try again.");
});

/* #2008 — the publisher key flow, in a real browser.
   These are the checks a unit test cannot make: what actually leaves the browser, and what is
   left behind afterwards. The key below is obviously fake. */

const FAKE_KEY = "not-a-real-key-0000000000";
const CONNECTED_SOURCE = {
  id: "22222222-2222-2222-2222-222222222222",
  label: "NewsAPI",
  canonicalDomain: "newsapi.org",
  homepageUrl: "https://newsapi.org/",
  feedUrl: null,
  retrievalMethod: "scrape" as const,
  validationStatus: "approved" as const,
  healthStatus: "available" as const,
  createdAt: "2026-08-20T00:00:00.000Z"
};

const OFFER = {
  connectionId: "newsapi-top-headlines",
  publisherName: "NewsAPI",
  requestHost: "newsapi.org",
  accessSummary: "Reads the top headlines this publisher already publishes.",
  termsUrl: "https://newsapi.org/terms"
};

test.describe("publisher keys (#2008)", () => {
  test("a reviewed publisher asks for a key; an ordinary one never does", async ({ page }) => {
    await page.route("**/api/news/sources/preview", (route) => {
      const body = route.request().postDataJSON() as { input: string };
      const reviewed = body.input.includes("newsapi.org");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ok",
          confirmationId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          candidates: [
            reviewed
              ? {
                  label: "NewsAPI",
                  canonicalDomain: "newsapi.org",
                  homepageUrl: "https://newsapi.org/",
                  retrievalMethod: "scrape",
                  sampleCount: 5
                }
              : {
                  label: "The Atlantic",
                  canonicalDomain: "theatlantic.com",
                  homepageUrl: "https://www.theatlantic.com",
                  retrievalMethod: "scrape",
                  sampleCount: 5
                }
          ],
          candidateIds: ["dddddddd-dddd-dddd-dddd-dddddddddddd"],
          ...(reviewed ? { connection: OFFER } : {})
        })
      });
    });

    await page.goto("/settings?section=modules&module=news");
    const input = page.getByLabel("Publication homepage or domain");

    // An ordinary publication: the existing add path, and no key box anywhere.
    await input.fill("theatlantic.com");
    await page.getByRole("button", { name: "Check" }).click();
    await expect(page.getByRole("button", { name: "Add this source" })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

    // The reviewed publisher: who it is and exactly where the key goes, before the box is usable.
    await input.fill("newsapi.org");
    await page.getByRole("button", { name: "Check" }).click();
    await expect(page.getByLabel("Access key")).toBeVisible();
    await expect(page.getByText("newsapi.org", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(OFFER.accessSummary)).toBeVisible();
    await expect(page.getByRole("link", { name: /terms/i })).toHaveAttribute(
      "href",
      "https://newsapi.org/terms"
    );
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();

    // Typing alone is not enough; permission has to be confirmed too.
    await page.getByLabel("Access key").fill(FAKE_KEY);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
  });

  test("the key goes in the request body, never in a URL, and nothing is left behind", async ({
    page
  }) => {
    await page.route("**/api/news/sources/preview", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ok",
          confirmationId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          candidates: [
            {
              label: "NewsAPI",
              canonicalDomain: "newsapi.org",
              homepageUrl: "https://newsapi.org/",
              retrievalMethod: "scrape",
              sampleCount: 5
            }
          ],
          candidateIds: ["dddddddd-dddd-dddd-dddd-dddddddddddd"],
          connection: OFFER
        })
      })
    );
    await page.route("**/api/news/sources/credentialed", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          source: CONNECTED_SOURCE,
          credential: {
            sourceId: CONNECTED_SOURCE.id,
            connectionId: OFFER.connectionId,
            publisherName: "NewsAPI",
            status: "configured",
            lastValidatedAt: "2026-08-27T09:00:00.000Z",
            revokedAt: null
          },
          message: "Connected. News will use this source on its next refresh."
        })
      })
    );

    // Every request the page makes, so "the key went nowhere else" is checked, not assumed.
    const urls: string[] = [];
    page.on("request", (request) => urls.push(request.url()));

    await page.goto("/settings?section=modules&module=news");
    await page.getByLabel("Publication homepage or domain").fill("newsapi.org");
    await page.getByRole("button", { name: "Check" }).click();
    await page.getByLabel("Access key").fill(FAKE_KEY);
    await page.getByLabel("I have permission to use this key here.").check();

    const [connectRequest] = await Promise.all([
      page.waitForRequest(
        (request) =>
          request.url().includes("/api/news/sources/credentialed") && request.method() === "POST"
      ),
      page.getByRole("button", { name: "Connect", exact: true }).click()
    ]);

    expect(connectRequest.postDataJSON()).toEqual({
      connectionId: OFFER.connectionId,
      apiKey: FAKE_KEY
    });

    // The key must never travel in an address, where it would land in server and proxy logs.
    for (const url of urls) expect(url).not.toContain(FAKE_KEY);

    // And nothing may keep a copy in the browser.
    const stored = await page.evaluate(() => ({
      local: JSON.stringify(Object.entries(window.localStorage)),
      session: JSON.stringify(Object.entries(window.sessionStorage)),
      cookie: document.cookie
    }));
    expect(stored.local).not.toContain(FAKE_KEY);
    expect(stored.session).not.toContain(FAKE_KEY);
    expect(stored.cookie).not.toContain(FAKE_KEY);
  });

  test("a rejected replacement says the previous key is still active, and nothing changes", async ({
    page
  }) => {
    await page.route("**/api/news/personalization", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          availability: {
            aiConfigured: true,
            webSearchConfigured: true,
            customSourceByUrlEnabled: true,
            customSourceByNameEnabled: true,
            freeformTopicsEnabled: true
          },
          customSources: [CONNECTED_SOURCE],
          customTopics: [],
          sourceExclusions: [],
          snapshot: null,
          refresh: { state: "idle", updatedAt: null }
        })
      })
    );
    await page.route("**/api/news/credentials", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credentials: [
            {
              sourceId: CONNECTED_SOURCE.id,
              connectionId: OFFER.connectionId,
              publisherName: "NewsAPI",
              status: "configured",
              lastValidatedAt: "2026-08-27T09:00:00.000Z",
              revokedAt: null
            }
          ]
        })
      })
    );
    await page.route(`**/api/news/sources/${CONNECTED_SOURCE.id}/credential`, (route) => {
      if (route.request().method() !== "POST") return route.continue();
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: "The publisher rejected this key. Your previous key is still active."
        })
      });
    });

    await page.goto("/settings?section=modules&module=news");
    // The publications list and the key list are two separate requests, and with several
    // browser tests sharing one dev server the second can land well after the first.
    await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "Replace key for NewsAPI" }).click();
    await page.getByLabel("Access key").fill(FAKE_KEY);
    await page.getByLabel("I have permission to use this key here.").check();
    await page.getByRole("button", { name: "Save key" }).click();

    await expect(page.getByText("Your previous key is still active.")).toBeVisible();
    // The stored key was not replaced, so the source still reads as connected.
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText("Access revoked")).toHaveCount(0);
  });

  test("revoking says so plainly and changes what the publication shows", async ({ page }) => {
    let revoked = false;
    await page.route("**/api/news/personalization", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          availability: {
            aiConfigured: true,
            webSearchConfigured: true,
            customSourceByUrlEnabled: true,
            customSourceByNameEnabled: true,
            freeformTopicsEnabled: true
          },
          customSources: [CONNECTED_SOURCE],
          customTopics: [],
          sourceExclusions: [],
          snapshot: null,
          refresh: { state: "idle", updatedAt: null }
        })
      })
    );
    await page.route("**/api/news/credentials", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credentials: [
            {
              sourceId: CONNECTED_SOURCE.id,
              connectionId: OFFER.connectionId,
              publisherName: "NewsAPI",
              status: revoked ? "revoked" : "configured",
              lastValidatedAt: "2026-08-27T09:00:00.000Z",
              revokedAt: revoked ? "2026-08-27T10:00:00.000Z" : null
            }
          ]
        })
      })
    );
    await page.route(`**/api/news/sources/${CONNECTED_SOURCE.id}/credential`, (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      revoked = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credential: {
            sourceId: CONNECTED_SOURCE.id,
            connectionId: OFFER.connectionId,
            publisherName: "NewsAPI",
            status: "revoked",
            lastValidatedAt: "2026-08-27T09:00:00.000Z",
            revokedAt: "2026-08-27T10:00:00.000Z"
          },
          message: "Access revoked. Add a new key to reconnect this source."
        })
      });
    });

    await page.goto("/settings?section=modules&module=news");
    // The publications list and the key list are two separate requests, and with several
    // browser tests sharing one dev server the second can land well after the first.
    await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15000 });

    // Revoking is confirmed once rather than done on a single click.
    await page.getByRole("button", { name: "Revoke access for NewsAPI" }).click();
    await expect(page.getByText("News will stop using this key.")).toBeVisible();
    await page.getByRole("button", { name: "Yes, revoke" }).click();

    await expect(page.getByText("Access revoked")).toBeVisible();
  });
});
