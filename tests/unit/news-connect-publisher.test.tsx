import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { NEWS_CREDENTIAL_MESSAGES, type NewsPublisherConnectionOfferDto } from "@moss/shared";

import {
  ConnectPublisherForm,
  credentialOutcomeMessage,
  credentialStatusBadge
} from "../../packages/news/src/settings/connect-publisher.js";

// #2008. This repository has no jsdom and no Testing Library on purpose, so these tests cover
// the pure helpers and the rendered markup. Typing into the box and watching what leaves the
// browser is covered by tests/e2e/news-settings.spec.ts.

const offer: NewsPublisherConnectionOfferDto = {
  connectionId: "newsapi-top-headlines",
  publisherName: "NewsAPI",
  requestHost: "newsapi.org",
  accessSummary: "Reads the top headlines this publisher already publishes.",
  termsUrl: "https://newsapi.org/terms"
};

function render(node: React.ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(createElement(QueryClientProvider, { client }, node));
}

describe("credential outcome sentences", () => {
  it("uses the exact sentence the route reports, for every outcome", () => {
    for (const [outcome, sentence] of Object.entries(NEWS_CREDENTIAL_MESSAGES)) {
      expect(credentialOutcomeMessage(outcome)).toBe(sentence);
    }
  });

  it("falls back to generic copy for an unknown outcome, and never echoes it", () => {
    const message = credentialOutcomeMessage("something_new_from_the_server");
    expect(message).toBe("That did not work. Try again.");
    expect(message).not.toContain("something_new");
  });
});

describe("credential status badges", () => {
  it("names each stored state so a broken feed cannot read as connected", () => {
    expect(credentialStatusBadge("configured")).toEqual({ label: "Connected", tone: "pine" });
    expect(credentialStatusBadge("revoked")).toEqual({ label: "Access revoked", tone: "amber" });
    expect(credentialStatusBadge("not_configured")).toEqual({ label: "No key", tone: "neutral" });
  });
});

describe("the key box", () => {
  const markup = render(
    createElement(ConnectPublisherForm, {
      offer,
      mode: { kind: "connect" as const },
      onDone: () => {},
      onCancel: () => {}
    })
  );

  it("says who the publisher is and exactly where the key goes, above the box", () => {
    expect(markup).toContain("NewsAPI");
    expect(markup).toContain("newsapi.org");
    expect(markup).toContain(offer.accessSummary);
    expect(markup.indexOf("newsapi.org")).toBeLessThan(markup.indexOf('type="password"'));
  });

  it("links the publisher's own terms", () => {
    expect(markup).toContain('href="https://newsapi.org/terms"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it("is a password box that browsers will not autofill", () => {
    expect(markup).toContain('type="password"');
    expect(markup.toLowerCase()).toContain('autocomplete="off"');
  });

  it("is never filled from server data", () => {
    // A "stored key" placeholder holding a real value is how a secret gets back on screen.
    const box = markup.slice(
      markup.indexOf('type="password"'),
      markup.indexOf('type="password"') + 400
    );
    expect(box).not.toContain("value=");
  });

  it("cannot be submitted until the box has a value and permission is confirmed", () => {
    expect(markup).toContain("I have permission to use this key here.");
    // Both controls start empty/unticked, so the submit button renders disabled.
    expect(markup).toContain("disabled");
  });

  it("renders no terms link when the connection declares none", () => {
    const noTerms = render(
      createElement(ConnectPublisherForm, {
        offer: { ...offer, termsUrl: null },
        mode: { kind: "connect" as const },
        onDone: () => {},
        onCancel: () => {}
      })
    );
    expect(noTerms).not.toContain("Read NewsAPI");
  });

  it("says Save key rather than Connect when replacing an existing key", () => {
    const replacing = render(
      createElement(ConnectPublisherForm, {
        offer,
        mode: { kind: "replace" as const, sourceId: "11111111-1111-1111-1111-111111111111" },
        onDone: () => {},
        onCancel: () => {}
      })
    );
    expect(replacing).toContain("Save key");
    // The source id belongs in the request path, never on screen next to the key box.
    expect(replacing).not.toContain("11111111-1111-1111-1111-111111111111");
  });
});
