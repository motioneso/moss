import { describe, expect, it } from "vitest";

import { isImapSignInRefused } from "../../packages/connectors/src/imap-sync-jobs.js";

/**
 * A refused mailbox sign-in must be told apart from "some mail did not come through", because
 * the two need different words and a different remedy on the settings screen.
 */
describe("isImapSignInRefused", () => {
  it("recognises the flag ImapFlow sets when the server refuses the sign-in", () => {
    const error = Object.assign(new Error("Invalid credentials (Failure)"), {
      name: "AuthenticationFailedError",
      authenticationFailed: true
    });
    expect(isImapSignInRefused(error)).toBe(true);
  });

  it("recognises the server's own refusal text and response code", () => {
    for (const text of [
      "AUTHENTICATIONFAILED",
      "Authentication failed",
      "Invalid credentials",
      "LOGIN failed",
      "password incorrect"
    ]) {
      expect(isImapSignInRefused(new Error(text))).toBe(true);
    }
    expect(isImapSignInRefused({ responseText: "NO [AUTHENTICATIONFAILED] nope" })).toBe(true);
  });

  it("leaves an ordinary read failure alone", () => {
    expect(isImapSignInRefused(new Error("socket hang up"))).toBe(false);
    expect(isImapSignInRefused(new Error("Mailbox does not exist"))).toBe(false);
    expect(isImapSignInRefused(null)).toBe(false);
    expect(isImapSignInRefused("authentication failed")).toBe(false);
  });
});
