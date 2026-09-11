import type {
  OnboardingProviderCheckResponse,
  OnboardingProviderKind,
  OnboardingProviderInstallRequest,
  OnboardingProviderInstallResponse,
  OnboardingProviderLoginBeginRequest,
  OnboardingProviderLoginPollRequest,
  OnboardingProviderLoginResponse,
  OnboardingProviderLoginSubmitTokenRequest
} from "@moss/shared";

import { requestJson } from "./client.js";

export async function checkOnboardingProvider(
  providerKind: OnboardingProviderKind
): Promise<OnboardingProviderCheckResponse> {
  return requestJson<OnboardingProviderCheckResponse>("/api/onboarding/provider-check", {
    method: "POST",
    body: { providerKind }
  });
}

// ---------------------------------------------------------------------------
// #365 onboarding provider-connect: thin client wrappers over the existing install/login
// routes. Kept in their own module (not client.ts) to respect the 1000-line file-size gate;
// they reuse the shared `requestJson` helper exported from client.ts (one-way import, no cycle).
// ---------------------------------------------------------------------------

export async function installOnboardingProvider(
  input: OnboardingProviderInstallRequest
): Promise<OnboardingProviderInstallResponse> {
  return requestJson<OnboardingProviderInstallResponse>("/api/onboarding/provider-install", {
    method: "POST",
    body: input
  });
}

export async function beginOnboardingProviderLogin(
  input: OnboardingProviderLoginBeginRequest
): Promise<OnboardingProviderLoginResponse> {
  return requestJson<OnboardingProviderLoginResponse>("/api/onboarding/provider-login/begin", {
    method: "POST",
    body: input
  });
}

// The pasted code is auth material: forwarded straight to the route, never logged or stored.
export async function submitOnboardingProviderLoginToken(
  input: OnboardingProviderLoginSubmitTokenRequest
): Promise<OnboardingProviderLoginResponse> {
  return requestJson<OnboardingProviderLoginResponse>(
    "/api/onboarding/provider-login/submit-token",
    { method: "POST", body: input }
  );
}

export async function pollOnboardingProviderLogin(
  input: OnboardingProviderLoginPollRequest
): Promise<OnboardingProviderLoginResponse> {
  return requestJson<OnboardingProviderLoginResponse>("/api/onboarding/provider-login/poll", {
    method: "POST",
    body: input
  });
}

/** Cancel an abandoned login so the runner's single-login slot is released. */
export async function cancelOnboardingProviderLogin(
  input: OnboardingProviderLoginPollRequest
): Promise<void> {
  await requestJson<unknown>("/api/onboarding/provider-login/cancel", {
    method: "POST",
    body: input
  });
}
