import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { SportsPage } from "../../packages/sports/src/web/sports-page.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";
import { makeOverview, standingsGroup } from "./sports-page-fixtures.js";

// Renders with react-dom/server against a primed query cache, like sports-page.test.tsx.

describe("Sports standings rail refresh warning", () => {
  it("warns in the standings rail when the standings refresh degraded (#2686)", () => {
    const renderRail = (degraded: boolean) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(sportsQueryKeys.overview, makeOverview({ standings: [] }));
      client.setQueryData(sportsQueryKeys.standings("nfl"), {
        group: { ...standingsGroup(), sections: [] },
        fixtures: [],
        degraded
      });
      return renderToString(
        createElement(QueryClientProvider, { client }, createElement(SportsPage))
      );
    };
    const html = renderRail(true);
    expect(html).toContain("Standings could not be updated just now");
    expect(html).not.toContain("Some sports information could not be updated");
    expect(renderRail(false)).not.toContain("could not be updated");
  });
});
