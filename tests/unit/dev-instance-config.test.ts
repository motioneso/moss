import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDevInstanceConfig } from "../../scripts/dev-instance/config.js";

describe("dev-instance config (#1258)", () => {
  it("applies defaults when the environment is empty", () => {
    const config = readDevInstanceConfig({});

    expect(config).toEqual({
      providerKind: "anthropic",
      credentialFilePath: join(homedir(), ".config/moss/uat/anthropic-oauth.env.gpg"),
      adminEmail: "ben@ben.com",
      adminName: "Ben",
      adminPasswordFilePath: join(homedir(), ".config/moss/dev/admin-password"),
      cliHomeBase: join(homedir(), ".local/share/moss/cli-auth"),
      cliRunnerSocketPath: "/run/jarv1s/cli-runner.sock"
    });
  });

  it("honours each override", () => {
    const env = {
      MOSS_DEV_INSTANCE_PROVIDER_KIND: "openai-compatible",
      MOSS_DEV_INSTANCE_CREDENTIAL_FILE: "/tmp/creds.gpg",
      JARVIS_DEV_EMAIL: "someone@example.com",
      MOSS_DEV_INSTANCE_ADMIN_NAME: "Someone",
      MOSS_DEV_INSTANCE_ADMIN_PASSWORD_FILE: "/tmp/admin-password",
      JARVIS_CLI_HOME_BASE: "/tmp/cli-home",
      JARVIS_CLI_RUNNER_SOCKET: "/tmp/cli-runner.sock"
    };

    const config = readDevInstanceConfig(env);

    expect(config).toEqual({
      providerKind: "openai-compatible",
      credentialFilePath: "/tmp/creds.gpg",
      adminEmail: "someone@example.com",
      adminName: "Someone",
      adminPasswordFilePath: "/tmp/admin-password",
      cliHomeBase: "/tmp/cli-home",
      cliRunnerSocketPath: "/tmp/cli-runner.sock"
    });
  });

  it("honours the Moss-prefixed name for cliHomeBase, which is not carved out", () => {
    const config = readDevInstanceConfig({ MOSS_CLI_HOME_BASE: "/tmp/moss-cli-home" });
    expect(config.cliHomeBase).toBe("/tmp/moss-cli-home");
  });

  it("ignores a Moss-prefixed name for the two truly carved-out fields", () => {
    const config = readDevInstanceConfig({
      MOSS_DEV_EMAIL: "moss-named@example.com",
      MOSS_CLI_RUNNER_SOCKET: "/tmp/moss-cli-runner.sock"
    });

    expect(config.adminEmail).toBe("ben@ben.com");
    expect(config.cliRunnerSocketPath).toBe("/run/jarv1s/cli-runner.sock");
  });

  it("rejects a providerKind that is not a valid AiProviderKind", () => {
    expect(() =>
      readDevInstanceConfig({ MOSS_DEV_INSTANCE_PROVIDER_KIND: "not-a-real-provider" })
    ).toThrow(/providerKind/);
  });
});
