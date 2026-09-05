import { describe, expect, it, vi } from "vitest";

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

describe("verified login configuration wiring", () => {
  it("rejects missing or foreign configurations and carries scope over all RPC verbs", async () => {
    const scope = { actorUserId: "actor-a", providerConfigId: "config-a" };
    const outcome = { loginId: "login-a", status: "awaiting_token" as const };
    const conn = {
      beginLogin: vi.fn(async () => outcome),
      pollLogin: vi.fn(async () => outcome),
      submitLoginToken: vi.fn(async () => outcome),
      cancelLogin: vi.fn(async () => ({ ok: true }))
    };
    const findLoginTargetProvider = vi.fn();
    const seam = buildOnboardingLogin({
      enabled: true,
      getConnection: () => conn as never,
      repository,
      providerRepository: { findLoginTargetProvider }
    })!;
    const db = {} as never;
    for (const row of [undefined, { owner_user_id: "actor-b" }]) {
      findLoginTargetProvider.mockResolvedValueOnce(row);
      await expect(seam.assertProviderConfig!(db, "anthropic", scope)).rejects.toMatchObject({
        statusCode: 404
      });
      expect(conn.beginLogin).not.toHaveBeenCalled();
    }
    findLoginTargetProvider.mockResolvedValueOnce({ owner_user_id: scope.actorUserId });
    await seam.assertProviderConfig!(db, "anthropic", scope);
    expect(findLoginTargetProvider).toHaveBeenLastCalledWith(
      db,
      scope.providerConfigId,
      "anthropic"
    );
    await seam.loginClient.begin("anthropic", scope);
    await seam.loginClient.poll("anthropic", "login-a", scope);
    await seam.loginClient.submitToken("anthropic", "login-a", "synthetic-code", scope);
    await seam.loginClient.cancel("anthropic", "login-a", scope);
    expect(conn.beginLogin).toHaveBeenCalledWith({ provider: "anthropic", scope });
    expect(conn.pollLogin).toHaveBeenCalledWith({
      provider: "anthropic",
      loginId: "login-a",
      scope
    });
    expect(conn.submitLoginToken).toHaveBeenCalledWith({
      provider: "anthropic",
      loginId: "login-a",
      token: "synthetic-code",
      scope
    });
    expect(conn.cancelLogin).toHaveBeenCalledWith({
      provider: "anthropic",
      loginId: "login-a",
      scope
    });
  });
});
