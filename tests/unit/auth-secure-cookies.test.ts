/**
 * Unit test for the better-auth secure-cookie decision (#1505 security review follow-up).
 *
 * Turning TLS on must also stop the login cookie from working over plain HTTP. The signal
 * ("is a TLS-terminating reverse proxy in front of us?") is JARVIS_TRUST_PROXY — the same
 * one apps/api/src/server.ts already uses to decide XFF trust and the HSTS header.
 */
import { describe, expect, it } from "vitest";

import { createBetterAuthOptions, type BootstrapSettings } from "../../packages/auth/src/index.js";

const fakeSettings: BootstrapSettings = {
  recordBootstrapOwnerAuditEvent: async () => {},
  recordAuditEvent: async () => {}
};

function buildOptions(env: NodeJS.ProcessEnv) {
  return createBetterAuthOptions(
    {} as never,
    {} as never,
    env,
    {} as never,
    fakeSettings,
    undefined
  );
}

describe("createBetterAuthOptions secure cookies (#1505)", () => {
  it("forces secure cookies when JARVIS_TRUST_PROXY signals a TLS-terminating proxy", () => {
    const options = buildOptions({ JARVIS_TRUST_PROXY: "10.251.0.254" });
    expect(options.advanced?.useSecureCookies).toBe(true);
  });

  it("does not force secure cookies when JARVIS_TRUST_PROXY is unset (plain HTTP / LAN dev)", () => {
    const options = buildOptions({});
    expect(options.advanced?.useSecureCookies).toBe(false);
  });
});
