import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type {
  AiActionPolicyDto,
  AiActionPolicyTier,
  GetAiActionPoliciesResponse
} from "@moss/shared";

type EmailSettingsModule = {
  default: ComponentType;
  draftAutoChecked: (tier: AiActionPolicyTier) => boolean;
  draftAutoTierFromChecked: (checked: boolean) => AiActionPolicyTier;
  draftAutoTierFromPolicies: (
    policies: GetAiActionPoliciesResponse["policies"]
  ) => AiActionPolicyTier;
};

const emailSettingsModulePath: string = "../../packages/email/src/settings/index.js";
const {
  default: EmailSettings,
  draftAutoChecked,
  draftAutoTierFromChecked,
  draftAutoTierFromPolicies
} = (await import(emailSettingsModulePath)) as EmailSettingsModule;

function policy(overrides: Partial<AiActionPolicyDto>): AiActionPolicyDto {
  return { moduleId: "email", actionFamilyId: "email_drafts", tier: "trusted_auto", ...overrides };
}

describe("email_drafts policy ↔ toggle mapping", () => {
  it("defaults to ask_each_time (OFF) when no policy row exists", () => {
    expect(draftAutoTierFromPolicies([])).toBe("ask_each_time");
    expect(draftAutoChecked(draftAutoTierFromPolicies([]))).toBe(false);
  });

  it("reads the email/email_drafts tier and ignores other families", () => {
    const policies = [
      policy({ moduleId: "calendar", actionFamilyId: "calendar_events", tier: "trusted_auto" }),
      policy({ tier: "trusted_auto" })
    ];
    expect(draftAutoTierFromPolicies(policies)).toBe("trusted_auto");
    expect(draftAutoChecked("trusted_auto")).toBe(true);
  });

  it("does not treat a same-named family from another module as email's", () => {
    const policies = [policy({ moduleId: "other", tier: "trusted_auto" })];
    expect(draftAutoTierFromPolicies(policies)).toBe("ask_each_time");
  });

  it("maps checked ↔ tier both directions", () => {
    expect(draftAutoTierFromChecked(true)).toBe("trusted_auto");
    expect(draftAutoTierFromChecked(false)).toBe("ask_each_time");
    // round-trips through the two tiers the family allows
    expect(draftAutoChecked(draftAutoTierFromChecked(true))).toBe(true);
    expect(draftAutoChecked(draftAutoTierFromChecked(false))).toBe(false);
  });

  it("treats always_confirm as OFF (not one of the family's allowed tiers)", () => {
    expect(draftAutoChecked("always_confirm")).toBe(false);
  });
});

describe("EmailSettings pane", () => {
  it("renders the draft-agency toggle and the always-asks send notice", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToString(
      createElement(QueryClientProvider, { client }, createElement(EmailSettings))
    );
    expect(html).toContain("Let your assistant draft email replies without asking");
    expect(html).toContain("Sending a reply always asks first");
  });
});
