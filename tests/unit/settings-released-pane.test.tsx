import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownMessage } from "../../apps/web/src/chat/markdown-message.js";
import { ReleasedPane } from "../../apps/web/src/settings/settings-released-pane.js";

describe("ReleasedPane", () => {
  it("renders the bundled release history", () => {
    const html = renderToString(
      <ReleasedPane
        me={{
          user: {
            id: "user-1",
            email: "user@example.test",
            emailVerified: true,
            name: "User",
            status: "active",
            isInstanceAdmin: false,
            isBootstrapOwner: false,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z"
          },
          profilePrefs: { addressed: null },
          hasPasswordCredential: false
        }}
        onNavigate={() => undefined}
      />
    );

    expect(html).toContain("Recently Released");
    expect(html).toContain("Edge channel");
    expect(html.indexOf("Edge channel")).toBeLessThan(html.indexOf("2026-08-21"));
    expect(html).toContain("Recall relevant notes before answering");
    expect(html).toContain("Threaded chat routing");
    expect(html).toContain("v0.1.16");
    expect(html).toContain("2026-08-05");
    expect(html).toContain("Added");
    expect(html).toContain("Fixed");
    expect(html).toContain("Changed");
    expect(html).toContain("Guided Job Search onboarding");
    expect(html).toContain("More resilient live chat");
  });

  it("keeps raw HTML and unsafe links inert", () => {
    const html = renderToString(
      <MarkdownMessage text={'<script>alert("nope")</script> [unsafe](javascript:alert("nope"))'} />
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });
});
