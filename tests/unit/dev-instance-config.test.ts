import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDevInstanceConfig } from "../../scripts/dev-instance/config.js";

describe("dev-instance config (#1258)", () => {
  it("applies defaults when the environment is empty", () => {
    const config = readDevInstanceConfig({});

    expect(config).toEqual({
      providerKind: "anthropic",
      providerAuth: "cli",
      providerBaseUrl: null,
      providerKeyFilePath: null,
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
      providerAuth: "cli",
      providerBaseUrl: null,
      providerKeyFilePath: null,
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

describe("dev-instance config: API-key provider (#3410)", () => {
  const apiKeyEnv = {
    MOSS_DEV_INSTANCE_PROVIDER_KIND: "openai-compatible",
    MOSS_DEV_INSTANCE_PROVIDER_AUTH: "api_key",
    MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "http://proxy.test",
    MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: "~/ada/proxy-key"
  };

  it("reads auth, address and key file, expanding the home prefix", () => {
    const config = readDevInstanceConfig(apiKeyEnv);
    expect(config.providerAuth).toBe("api_key");
    expect(config.providerBaseUrl).toBe("http://proxy.test");
    expect(config.providerKeyFilePath).toBe(join(homedir(), "ada/proxy-key"));
  });

  it("allows an anthropic API-key provider with no address", () => {
    const config = readDevInstanceConfig({
      MOSS_DEV_INSTANCE_PROVIDER_KIND: "anthropic",
      MOSS_DEV_INSTANCE_PROVIDER_AUTH: "api_key",
      MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: "/tmp/ada-key"
    });
    expect(config.providerBaseUrl).toBeNull();
    expect(config.providerKeyFilePath).toBe("/tmp/ada-key");
  });

  it("treats empty values as unset", () => {
    const config = readDevInstanceConfig({
      MOSS_DEV_INSTANCE_PROVIDER_AUTH: "",
      MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "",
      MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: ""
    });
    expect(config.providerAuth).toBe("cli");
  });

  it("requires a key file for api_key", () => {
    expect(() =>
      readDevInstanceConfig({ ...apiKeyEnv, MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: undefined })
    ).toThrow(/MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE is required/);
  });

  it("refuses api_key for a kind chat cannot drive", () => {
    expect(() =>
      readDevInstanceConfig({ ...apiKeyEnv, MOSS_DEV_INSTANCE_PROVIDER_KIND: "google" })
    ).toThrow(/anthropic or openai-compatible/);
  });

  it("refuses an address or key file under cli auth", () => {
    expect(() =>
      readDevInstanceConfig({ MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "http://proxy.test" })
    ).toThrow(/apply only when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key/);
    expect(() =>
      readDevInstanceConfig({ MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE: "/tmp/ada-key" })
    ).toThrow(/apply only when MOSS_DEV_INSTANCE_PROVIDER_AUTH is api_key/);
  });

  it("refuses an address that is not http or https", () => {
    expect(() =>
      readDevInstanceConfig({
        ...apiKeyEnv,
        MOSS_DEV_INSTANCE_PROVIDER_BASE_URL: "ftp://proxy.test"
      })
    ).toThrow(/http:\/\/ or https:\/\//);
  });

  it("refuses an unknown auth value", () => {
    expect(() =>
      readDevInstanceConfig({ ...apiKeyEnv, MOSS_DEV_INSTANCE_PROVIDER_AUTH: "oauth" })
    ).toThrow(/providerAuth "oauth"/);
  });
});
