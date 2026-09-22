import { describe, expect, it } from "vitest";

import {
  looksLikeNoFailureSecurityNotice,
  resolveMaybeOwedGate
} from "../../packages/connectors/src/email-security-notice-rule.js";

const notice = (subject: string, body = "If this was you, no action is needed.") => ({
  subject,
  body
});

describe("no-failure security notice rule", () => {
  it("recognizes a new sign-in notice", () => {
    expect(looksLikeNoFailureSecurityNotice(notice("Verify Discord Login from New Location"))).toBe(
      true
    );
  });

  it("recognizes a password or two-step change", () => {
    expect(looksLikeNoFailureSecurityNotice(notice("Your password was changed"))).toBe(true);
    expect(looksLikeNoFailureSecurityNotice(notice("Two-step verification was turned on"))).toBe(
      true
    );
  });

  it("does NOT match a notice that reports a failure", () => {
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Unsuccessful sign-in attempt", "We blocked a sign-in from an unknown device.")
      )
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Security alert", "We locked your account after repeated failed attempts.")
      )
    ).toBe(false);
  });

  it("does NOT match ordinary mail that merely mentions signing in", () => {
    expect(
      looksLikeNoFailureSecurityNotice(notice("Your monthly account summary", "Reset anytime."))
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Newsletter", "Read our guide to account security and login tips.")
      )
    ).toBe(false);
  });
});

describe("resolveMaybeOwedGate", () => {
  const advert = { subject: "UP TO 60% OFF BEST SELLERS", body: "Shop the sale now." };

  it("resolves a bulk advert the model flagged anyway to nothing", () => {
    expect(resolveMaybeOwedGate(advert, "noise")).toBe("nothing");
  });

  it("resolves a no-failure sign-in notice to worth_knowing even when the model named an obligation", () => {
    expect(
      resolveMaybeOwedGate(notice("Verify Discord Login from New Location"), "needs_action")
    ).toBe("worth_knowing");
  });

  it("resolves an fyi answer to worth_knowing", () => {
    expect(resolveMaybeOwedGate({ subject: "Your parcel arrived", body: "" }, "fyi")).toBe(
      "worth_knowing"
    );
  });

  it("keeps maybe_owed when the model named a real obligation", () => {
    expect(resolveMaybeOwedGate({ subject: "Lease addendum", body: "" }, "needs_action")).toBe(
      "maybe_owed"
    );
    expect(resolveMaybeOwedGate({ subject: "Lease addendum", body: "" }, "unknown")).toBe(
      "maybe_owed"
    );
    expect(resolveMaybeOwedGate({ subject: "Lease addendum", body: "" }, undefined)).toBe(
      "maybe_owed"
    );
  });
});
