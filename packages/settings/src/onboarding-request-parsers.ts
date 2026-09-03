/**
 * Request-body parsers for the onboarding routes (provider check / install / login verbs). Split
 * out of `onboarding-routes.ts` in #2205 to keep that file under the repo's line budget; the
 * parsers validate shape only — the pasted login `token` is AUTH MATERIAL (login-contract §L.6.3)
 * and is never logged or echoed here.
 */

import { HttpError } from "@moss/module-sdk";
import type { OnboardingProviderCheckRequest, OnboardingProviderKind } from "@moss/shared";

export function parseOnboardingProviderCheckBody(body: unknown): OnboardingProviderCheckRequest {
  const value = requireObject(body);
  const providerKind = value.providerKind;
  if (
    providerKind !== "anthropic" &&
    providerKind !== "openai-compatible" &&
    providerKind !== "google"
  ) {
    throw new HttpError(400, "providerKind must be anthropic, openai-compatible, or google");
  }
  return { providerKind };
}

export function parseOnboardingProviderInstallBody(body: unknown): {
  readonly providerKind: OnboardingProviderKind;
} {
  const value = requireObject(body);
  const providerKind = value.providerKind;
  if (
    providerKind !== "anthropic" &&
    providerKind !== "openai-compatible" &&
    providerKind !== "google"
  ) {
    throw new HttpError(400, "providerKind must be anthropic, openai-compatible, or google");
  }
  return { providerKind };
}

/** Validate the provider kind in a login body (the shared first field of all four login routes). */
function validateProviderKind(value: unknown): OnboardingProviderKind {
  if (value !== "anthropic" && value !== "openai-compatible" && value !== "google") {
    throw new HttpError(400, "providerKind must be anthropic, openai-compatible, or google");
  }
  return value;
}

/** #2205: the optional clicked-row id; anything but a non-empty string is treated as absent. */
function parseProviderConfigId(value: Record<string, unknown>): {
  readonly providerConfigId?: string;
} {
  const raw = value.providerConfigId;
  return typeof raw === "string" && raw.length > 0 ? { providerConfigId: raw } : {};
}

export function parseLoginProviderBody(body: unknown): {
  readonly providerKind: OnboardingProviderKind;
  readonly providerConfigId?: string;
} {
  const value = requireObject(body);
  return {
    providerKind: validateProviderKind(value.providerKind),
    ...parseProviderConfigId(value)
  };
}

export function parseLoginHandleBody(body: unknown): {
  readonly providerKind: OnboardingProviderKind;
  readonly loginId: string;
  readonly providerConfigId?: string;
} {
  const value = requireObject(body);
  const providerKind = validateProviderKind(value.providerKind);
  if (typeof value.loginId !== "string" || value.loginId.length === 0) {
    throw new HttpError(400, "loginId is required");
  }
  return { providerKind, loginId: value.loginId, ...parseProviderConfigId(value) };
}

export function parseLoginSubmitTokenBody(body: unknown): {
  readonly providerKind: OnboardingProviderKind;
  readonly loginId: string;
  readonly token: string;
  readonly providerConfigId?: string;
} {
  const value = requireObject(body);
  const providerKind = validateProviderKind(value.providerKind);
  if (typeof value.loginId !== "string" || value.loginId.length === 0) {
    throw new HttpError(400, "loginId is required");
  }
  // AUTH MATERIAL (§L.6.3): validated for presence only — NEVER logged or echoed.
  if (typeof value.token !== "string" || value.token.length === 0) {
    throw new HttpError(400, "token is required");
  }
  return {
    providerKind,
    loginId: value.loginId,
    token: value.token,
    ...parseProviderConfigId(value)
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected JSON object body");
  }

  return value as Record<string, unknown>;
}
