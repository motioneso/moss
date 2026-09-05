// @vitest-environment jsdom
// #2232: the settings provider-login dialog started its login from a mount effect. Under React
// StrictMode (the dev server) that effect runs mount, cleanup, mount before the first request
// comes back, so two "begin" requests fired at once — the first got cancelled, the second was
// refused by the server as "Provider login is currently unavailable." These tests prove a
// StrictMode double-mount now starts exactly one login, and that a real close still cancels it.
import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiProviderConfigDto } from "@moss/shared";
import type * as ApiClient from "../../apps/web/src/api/client.js";

const beginMock = vi.fn(async () => ({
  loginId: "login-1",
  status: "awaiting_token" as const,
  authorizationUrl: "https://example.com/authorize"
}));
const cancelMock = vi.fn(async () => {});
const pollMock = vi.fn(async () => ({ loginId: "login-1", status: "awaiting_token" as const }));

vi.mock("../../apps/web/src/api/onboarding-connect-client.js", () => ({
  beginOnboardingProviderLogin: (...args: unknown[]) =>
    beginMock(...(args as Parameters<typeof beginMock>)),
  cancelOnboardingProviderLogin: (...args: unknown[]) =>
    cancelMock(...(args as Parameters<typeof cancelMock>)),
  pollOnboardingProviderLogin: (...args: unknown[]) =>
    pollMock(...(args as Parameters<typeof pollMock>)),
  submitOnboardingProviderLoginToken: vi.fn()
}));

vi.mock("../../apps/web/src/api/client.js", async () => {
  const actual = await vi.importActual<typeof ApiClient>("../../apps/web/src/api/client.js");
  return {
    ...actual,
    getPersonaSettings: vi.fn(async () => ({ persona: { assistantName: "Moss" } }))
  };
});

import { ProviderLoginDialog } from "../../apps/web/src/settings/settings-provider-login-dialog.js";

const provider: AiProviderConfigDto & { providerKind: "anthropic" } = {
  id: "cfg-1",
  providerKind: "anthropic",
  displayName: "Claude",
  baseUrl: null,
  status: "active",
  authMethod: "cli",
  executionMode: "interactive",
  hasCredential: false,
  cliAvailable: true,
  isInstanceDefault: false,
  revokedAt: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z"
};

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDialog(
  strict: boolean,
  onClose: () => void = () => {}
): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dialog = createElement(QueryClientProvider, { client }, [
    createElement(ProviderLoginDialog, {
      key: "dialog",
      provider,
      onClose,
      onSuccess: () => {}
    })
  ]);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(strict ? createElement(StrictMode, null, dialog) : dialog);
  });
  await flush();
  return renderer;
}

describe("ProviderLoginDialog under a StrictMode double mount (#2232)", () => {
  beforeEach(() => {
    beginMock.mockClear();
    cancelMock.mockClear();
    pollMock.mockClear();
  });

  it("starts exactly one login even though the mount effect runs twice", async () => {
    await renderDialog(true);
    expect(beginMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("still cancels the login on a real unmount", async () => {
    const renderer = await renderDialog(true);
    expect(beginMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
    await flush();

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerKind: "anthropic", loginId: "login-1" })
    );
  });

  it("starts one login under a normal (non-Strict) mount too", async () => {
    await renderDialog(false);
    expect(beginMock).toHaveBeenCalledTimes(1);
  });
  it("cancels with the clicked configuration when begin resolves after unmount", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof beginMock>>) => void;
    beginMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const renderer = await renderDialog(true);
    await act(async () => {
      renderer.unmount();
    });
    await flush();
    cancelMock.mockRejectedValueOnce(new Error("runner unavailable"));
    await act(async () => {
      resolve({
        loginId: "late-login",
        status: "awaiting_token",
        authorizationUrl: "https://example.com/authorize"
      });
    });
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith({
      providerKind: "anthropic",
      providerConfigId: provider.id,
      loginId: "late-login"
    });
  });
});
