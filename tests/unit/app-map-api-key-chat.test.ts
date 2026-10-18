import { describe, expect, it } from "vitest";

import {
  CORE_APP_ERRORS,
  CORE_APP_REMEDIATIONS,
  CORE_APP_SCREENS,
  CORE_APP_SETTINGS
} from "../../packages/shared/src/app-map-core.js";

describe("app map: API-key chat (#3410)", () => {
  it("names the unsupported-kind error and drops the old refusal", () => {
    const codes = CORE_APP_ERRORS.map((error) => error.code);
    expect(codes).toContain("core.ai.api_key_chat_provider_unsupported");
    expect(codes).not.toContain("core.ai.api_key_live_chat_unavailable");
  });

  it("tells admins that API-key providers can run chat", () => {
    const remediation = CORE_APP_REMEDIATIONS.find(
      (entry) => entry.id === "core.ai.connect_cli_provider"
    );
    expect(remediation?.description).toMatch(/Anthropic or OpenAI-compatible API-key provider/);

    const text = JSON.stringify([CORE_APP_SCREENS, CORE_APP_SETTINGS]);
    expect(text).not.toMatch(/API-key providers are not available yet/);
    expect(text).toMatch(/API-key provider card also shows whether chat can use it/);
  });

  it("quotes every chat readiness line on an API-key provider card", () => {
    const description =
      CORE_APP_SETTINGS.find((entry) => entry.id === "aiproviders")?.description ?? "";
    const marker = "API-key provider card also shows whether chat can use it";
    const readiness = description.slice(
      description.indexOf(marker),
      description.indexOf(marker) + 400
    );
    expect(readiness.startsWith(marker)).toBe(true);
    for (const line of [
      "The provider rejected the API key",
      "Could not reach the provider",
      "No API key is saved",
      "The chat program for this provider is not installed",
      "The sign-in helper is not running"
    ]) {
      expect(readiness).toContain(`'${line}'`);
    }
  });

  it("declares the refused provider address with a login in it", () => {
    const error = CORE_APP_ERRORS.find(
      (entry) => entry.code === "core.ai.provider_address_has_login"
    );
    expect(error).toMatchObject({ class: "validation" });
    expect(error?.description).toContain(
      "A provider address cannot include a username or password."
    );
  });

  it("declares a key rejected mid-chat with an admin remediation", () => {
    const error = CORE_APP_ERRORS.find((entry) => entry.code === "core.ai.api_key_rejected");
    expect(error).toMatchObject({
      class: "prerequisite",
      remediationRef: "core.ai.check_api_key"
    });
    expect(error?.description).toContain(
      "The provider rejected the API key. An admin can check it under Settings, AI providers."
    );
    const remediation = CORE_APP_REMEDIATIONS.find((entry) => entry.id === "core.ai.check_api_key");
    expect(remediation).toMatchObject({ path: "/settings?section=aiproviders", scope: "admin" });
  });
});
