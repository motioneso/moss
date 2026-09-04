import { describe, expect, it } from "vitest";

import { CliChatUnavailableError } from "@moss/chat";
import { HttpError } from "@moss/module-sdk";

import {
  buildCliModelLister,
  buildOnboardingLogin
} from "../../packages/module-registry/src/onboarding-login.js";

const repository = {} as never;

describe("onboarding provider-login wiring", () => {
  it("maps runner unavailability to a retryable HTTP 503", async () => {
    const seam = buildOnboardingLogin({
      enabled: true,
      getConnection: () =>
        ({
          beginLogin: async () => {
            throw new CliChatUnavailableError("a provider login is already in progress");
          }
        }) as never,
      repository
    });

    await expect(seam?.loginClient.begin("anthropic")).rejects.toMatchObject({
      statusCode: 503,
      message: "Provider login is currently unavailable. Please try again."
    });
    await expect(seam?.loginClient.begin("anthropic")).rejects.toBeInstanceOf(HttpError);
  });

  it("reports a missing runner connection as a retryable HTTP 503", async () => {
    const seam = buildOnboardingLogin({
      enabled: true,
      getConnection: () => undefined,
      repository
    });

    await expect(seam?.loginClient.begin("anthropic")).rejects.toMatchObject({ statusCode: 503 });
  });

  // #2208: the model-list port rides the same lazy connection and the same 503 mapping.
  it("lists CLI provider models over the runner connection and passes non-ok answers through", async () => {
    const listProviderModels = async ({ provider }: { provider: string }) =>
      provider === "anthropic"
        ? { status: "ok" as const, models: [{ id: "claude-fable-5-1" }] }
        : { status: "not_logged_in" as const };
    const lister = buildCliModelLister({
      enabled: true,
      getConnection: () => ({ listProviderModels }) as never
    });

    expect(await lister!("anthropic")).toEqual({
      status: "ok",
      models: [{ id: "claude-fable-5-1" }]
    });
    expect(await lister!("openai-compatible")).toEqual({ status: "not_logged_in" });
  });

  it("maps a missing or unavailable runner to a retryable HTTP 503 for model listing", async () => {
    expect(buildCliModelLister({ enabled: false, getConnection: () => undefined })).toBeUndefined();

    const missing = buildCliModelLister({ enabled: true, getConnection: () => undefined });
    await expect(missing!("anthropic")).rejects.toMatchObject({ statusCode: 503 });

    const down = buildCliModelLister({
      enabled: true,
      getConnection: () =>
        ({
          listProviderModels: async () => {
            throw new CliChatUnavailableError("runner down");
          }
        }) as never
    });
    await expect(down!("anthropic")).rejects.toBeInstanceOf(HttpError);
    await expect(down!("anthropic")).rejects.toMatchObject({ statusCode: 503 });
  });
});
