import { afterEach, describe, expect, it } from "vitest";

import type { TmuxIo } from "@moss/ai";

import { PersistentStreamDecoder } from "./persistent-stream-decoder.js";
import { clearProviderProbeCacheForTests, probeProvider } from "./provider-probe.js";

/** A claude CLI that always answers the readiness check successfully, plus a count of how many
 *  times it was actually asked, so a replayed saved answer is visible as a missing call. */
function alwaysReadyClaude() {
  let realChecks = 0;
  const io: Pick<TmuxIo, "run"> = {
    run: async () => {
      realChecks += 1;
      return { code: 0, stdout: "OK\n" };
    }
  };
  return { io, realChecks: () => realChecks };
}

async function drain(decoder: PersistentStreamDecoder) {
  const events = [];
  for await (const event of decoder.events()) events.push(event);
  return events;
}

function failedTurn(record: Record<string, unknown>) {
  const decoder = new PersistentStreamDecoder({ killChild: () => {} });
  decoder.beginTurn("turn-1");
  decoder.write(`${JSON.stringify(record)}\n`);
  decoder.end();
  return decoder;
}

describe("#2242: a chat message the provider refuses clears the saved sign-in answer", () => {
  afterEach(() => {
    clearProviderProbeCacheForTests();
  });

  it("makes the next readiness check ask for a login instead of replaying the old success", async () => {
    // The exact sequence the review found: a readiness check saves "the login works", the sign-in
    // is then revoked, and the person's next chat message comes back refused. Before this fix the
    // chat failure was flattened into a general failure and the saved success stood for the rest
    // of its five-minute life, so nobody was ever asked to log in again.
    const { io, realChecks } = alwaysReadyClaude();
    const deps = {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-live" }
    };

    expect(await probeProvider("anthropic", deps)).toEqual({ status: "ready" });

    const events = await drain(
      failedTurn({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["API Error: 401 invalid bearer token"]
      })
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "turn-failed" });
    expect(await probeProvider("anthropic", deps)).toEqual({ status: "needs_login" });
    // Only the first check ever ran for real; the second was answered from the refusal.
    expect(realChecks()).toBe(1);
  });

  it("says a login is needed rather than repeating the provider's own words", async () => {
    const events = await drain(
      failedTurn({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["API Error: 401 invalid bearer token for sk-secret-value"]
      })
    );

    const outcome = (events[0] as { outcome: { reason: string; loginRejected?: boolean } }).outcome;
    expect(outcome.loginRejected).toBe(true);
    expect(outcome.reason).toContain("Log in again");
    expect(outcome.reason).not.toContain("401");
    expect(outcome.reason).not.toContain("sk-secret-value");
  });

  it("leaves the saved answer alone when the failure was not about signing in", async () => {
    const { io, realChecks } = alwaysReadyClaude();
    const deps = {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-live" }
    };

    expect(await probeProvider("anthropic", deps)).toEqual({ status: "ready" });

    const events = await drain(
      failedTurn({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["the assistant process ran out of memory"]
      })
    );

    const outcome = (events[0] as { outcome: { reason: string; loginRejected?: boolean } }).outcome;
    expect(outcome.loginRejected).toBeUndefined();
    expect(outcome.reason).toContain("reported an error");
    expect(await probeProvider("anthropic", deps)).toEqual({ status: "ready" });
    expect(realChecks()).toBe(1);
  });

  it("does not read the assistant's own reply as a refused sign-in", async () => {
    const events = await drain(
      failedTurn({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        message: "the user asked about a 401 unauthorized page on their website"
      })
    );

    const outcome = (events[0] as { outcome: { loginRejected?: boolean } }).outcome;
    expect(outcome.loginRejected).toBeUndefined();
  });
});
