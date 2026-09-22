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

  it("recognizes a password or two-step change that reports no failure", () => {
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Your password was changed", "If this was you, ignore this email.")
      )
    ).toBe(true);
    expect(looksLikeNoFailureSecurityNotice(notice("Two-step verification was turned on"))).toBe(
      true
    );
  });

  it("does NOT match alerts that report a problem or ask the user to act", () => {
    // Every sample here is a genuine alert that must still reach the closer look.
    expect(
      looksLikeNoFailureSecurityNotice(
        notice(
          "Microsoft account security alert",
          "We detected something unusual about a recent sign-in."
        )
      )
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Security alert", "Suspicious activity was detected on your account.")
      )
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("New sign-in from Lagos, Nigeria", "Was this you? If not, secure your account.")
      )
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Your password was changed", "If you didn\u2019t make this change, reset it now.")
      )
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Recovery email changed", "If this wasn\u2019t you, act now.")
      )
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Password reset request", "Someone requested a password reset for your account.")
      )
    ).toBe(false);
    expect(
      looksLikeNoFailureSecurityNotice(
        notice("Unsuccessful sign-in attempt", "We blocked a sign-in from an unknown device.")
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
  const advert = { subject: "UP TO 60% OFF BEST SELLERS", body: "Shop the sale now. Unsubscribe." };
  const bulkUnknown = { bulk: true, knownSender: false };
  const bulkKnown = { bulk: true, knownSender: true };
  const ordinaryUnknown = { bulk: false, knownSender: false };

  it("resolves a bulk advert from an unknown sender by the model's own verdict", () => {
    expect(resolveMaybeOwedGate(advert, "noise", bulkUnknown)).toBe("nothing");
    expect(resolveMaybeOwedGate(advert, "fyi", bulkUnknown)).toBe("worth_knowing");
  });

  it("never takes the shortcut for a known sender, even bulk mail", () => {
    expect(resolveMaybeOwedGate(advert, "fyi", bulkKnown)).toBe("maybe_owed");
    expect(resolveMaybeOwedGate(advert, "noise", bulkKnown)).toBe("maybe_owed");
  });

  it("never takes the shortcut for non-bulk mail", () => {
    expect(
      resolveMaybeOwedGate({ subject: "Lunch?", body: "Are you free?" }, "fyi", ordinaryUnknown)
    ).toBe("maybe_owed");
  });

  it("drops a no-failure sign-in notice quietly", () => {
    const login = notice("Verify Discord Login from New Location");
    expect(resolveMaybeOwedGate(login, "fyi", ordinaryUnknown)).toBe("nothing");
    expect(resolveMaybeOwedGate(login, "noise", ordinaryUnknown)).toBe("nothing");
    expect(resolveMaybeOwedGate(login, "unknown", ordinaryUnknown)).toBe("nothing");
  });

  it("never overrides an answer that named a real obligation", () => {
    const login = notice("Verify Discord Login from New Location");
    expect(resolveMaybeOwedGate(login, "needs_action", ordinaryUnknown)).toBe("maybe_owed");
    expect(resolveMaybeOwedGate(login, "needs_reply", ordinaryUnknown)).toBe("maybe_owed");
    expect(
      resolveMaybeOwedGate(
        { subject: "Electric bill due Friday", body: "Unsubscribe" },
        "needs_action",
        bulkUnknown
      )
    ).toBe("maybe_owed");
  });

  it("keeps an unknown answer", () => {
    expect(
      resolveMaybeOwedGate({ subject: "Lease addendum", body: "" }, "unknown", ordinaryUnknown)
    ).toBe("maybe_owed");
    expect(
      resolveMaybeOwedGate({ subject: "Lease addendum", body: "" }, undefined, ordinaryUnknown)
    ).toBe("maybe_owed");
  });
});
