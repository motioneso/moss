// #1759: a module page has to lead to its own settings page. Job Search's own settings live on the
// host at /settings?section=modules&module=job-search — external modules can never contribute a
// settings surface (packages/settings-ui/src/scanner.ts scans packages/ and node_modules only), so
// without this link the page a user is standing on has no way to reach them.
//
// This lives in its own file rather than in job-search-web-root.test.tsx because that file is at
// the 1000-line ceiling that check:file-size enforces; one more test tips it over.
//
// Asserted in the empty-profile state, which renders the masthead with nothing else on the page —
// a link that only appeared once the board had results would be the same defect in a new place.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const { mockUseProfiles } = vi.hoisted(() => ({ mockUseProfiles: vi.fn() }));
vi.mock("../../external-modules/job-search/src/web/use-profiles", () => ({
  useProfiles: mockUseProfiles
}));

// Both must resolve rather than return undefined: Root's bootstrap effect chains off them on
// mount, so a bare vi.fn() fails on `.then` before anything renders.
vi.mock("../../external-modules/job-search/src/web/api", () => ({
  invokeTool: vi.fn(async () => ({ data: null })),
  runQueue: vi.fn(async () => ({ data: null }))
}));

vi.mock("../../external-modules/job-search/src/web/latch", () => ({
  isLatched: () => false,
  setLatched: () => undefined
}));

vi.mock("../../external-modules/job-search/src/web/styles.css", () => ({ default: "" }));

import { Root } from "../../external-modules/job-search/src/web/root";

describe("job-search web Root (#1759)", () => {
  it("links to its own settings page from the masthead", async () => {
    mockUseProfiles.mockReturnValue({ status: "empty", refetch: vi.fn(), select: vi.fn() });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(Root, {
          hostActions: { actorScopeKey: "actor-1", openAssistant: vi.fn() }
        })
      );
    });

    const hrefs = renderer.root
      .findAllByType("a")
      .map((node) => node.props.href as string | undefined);
    expect(hrefs).toContain("/settings?section=modules&module=job-search");
  });
});
