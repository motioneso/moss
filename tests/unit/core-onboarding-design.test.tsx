import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { AuthScreen } from "../../apps/web/src/auth/auth-screen.js";
import { StepHeader } from "../../apps/web/src/onboarding/onboarding-ui.js";
import { WelcomeStep } from "../../apps/web/src/onboarding/welcome-step.js";
import { MemberWelcomeStep } from "../../apps/web/src/onboarding/member-welcome-step.js";

function renderAuth(needsBootstrap: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={client}>
      <AuthScreen needsBootstrap={needsBootstrap} onAuthenticated={async () => undefined} />
    </QueryClientProvider>
  );
}

describe("core account-entry design", () => {
  it("keeps sign-in validation and uses named canonical controls", () => {
    const html = renderAuth(false);
    expect(html).toContain('class="jds-segmented"');
    expect(html).toContain('role="group" aria-label="Auth mode"');
    expect(html).toContain('for="auth-email"');
    expect(html).toContain('id="auth-email"');
    expect(html).toContain('for="auth-password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('minLength="8"');
    expect(html).toContain('required=""');
    expect(html).toContain('type="submit" class="jds-btn jds-btn--primary jds-btn--block"');
  });

  it("keeps bootstrap account mode and required name/password semantics", () => {
    const html = renderAuth(true);
    expect(html).not.toContain('aria-label="Auth mode"');
    expect(html).toContain('for="auth-name"');
    expect(html).toContain('id="auth-name"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("Create owner account");
  });

  it("gives the shared step header the id supplied by its section", () => {
    const html = renderToString(
      <StepHeader titleId="test-step" eyebrow="Setup" title="A named step" />
    );
    expect(html).toContain('<h1 id="test-step" class="onb-title">');
    expect(html).toContain("jds-eyebrow");
  });

  it.each([
    [WelcomeStep, "onboarding-welcome-title"],
    [MemberWelcomeStep, "member-welcome-title"]
  ] as const)("names the rendered welcome section from its visible heading", (Component, id) => {
    const html = renderToString(createElement(Component, { onSkipAll: () => undefined }));
    expect(html).toContain(`aria-labelledby="${id}"`);
    expect(html).toContain(`<h1 id="${id}"`);
  });
});
