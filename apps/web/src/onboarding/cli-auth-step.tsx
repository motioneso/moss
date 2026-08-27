import { useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  Copy,
  ExternalLink,
  Info,
  LoaderCircle,
  LogIn,
  ShieldCheck
} from "lucide-react";

import type { OnboardingCliAuthStepDto, OnboardingProviderKind } from "@moss/shared";

import { ApiError } from "../api/client";
import {
  beginOnboardingProviderLogin,
  installOnboardingProvider,
  pollOnboardingProviderLogin,
  submitOnboardingProviderLoginToken
} from "../api/onboarding-connect-client";
import { useAssistantName } from "../api/use-assistant-name";
import {
  deriveCardModel,
  IDLE_LOGIN,
  interpretLoginResponse,
  shouldAutoLogin,
  type CardModel,
  type LoginNext,
  type LoginSession
} from "./provider-connect-machine";
import { StepHeader } from "./onboarding-ui";

// Display labels only — the control flow is data-driven (the `installable` flag from the catalog
// `supported` set decides whether a card offers Connect). No provider is hardcoded into the logic.
const PROVIDER_LABELS: Record<OnboardingProviderKind, string> = {
  anthropic: "Claude",
  "openai-compatible": "Codex",
  google: "Gemini"
};

// Bounded login poll (login-contract: submit may not settle synchronously). Iteration-based so a
// hung browser round-trip can never freeze the step.
const MAX_POLLS = 20;
const POLL_INTERVAL_MS = 1500;

interface ConnectState {
  readonly login: LoginSession;
  readonly installing: boolean;
  readonly busy: boolean;
  readonly error?: string;
  /** The pasted authorization code — AUTH MATERIAL, held only until submit, then cleared. */
  readonly token: string;
}

const DEFAULT_STATE: ConnectState = {
  login: IDLE_LOGIN,
  installing: false,
  busy: false,
  token: ""
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

export async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Plain-HTTP LAN origins can expose clipboard.writeText but reject its use.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    textarea.remove();
  }
}

export function CliAuthStep(props: {
  readonly step: OnboardingCliAuthStepDto;
  readonly onRecheck: () => Promise<unknown> | void;
}) {
  const assistantName = useAssistantName();
  const [states, setStates] = useState<Partial<Record<OnboardingProviderKind, ConnectState>>>({});

  const stateFor = (kind: OnboardingProviderKind): ConnectState => states[kind] ?? DEFAULT_STATE;

  const patch = (kind: OnboardingProviderKind, next: Partial<ConnectState>) =>
    setStates((current) => ({
      ...current,
      [kind]: { ...DEFAULT_STATE, ...current[kind], ...next }
    }));

  const refresh = () => {
    void Promise.resolve(props.onRecheck());
  };

  const handleError = (kind: OnboardingProviderKind, error: unknown) => {
    // The single-active-user gate (#347) returns 503 — surface an inline busy state, never crash.
    if (error instanceof ApiError && error.status === 503) {
      patch(kind, { busy: true, installing: false, login: IDLE_LOGIN });
      return;
    }
    patch(kind, { error: errorText(error), installing: false, login: IDLE_LOGIN });
  };

  // Apply the pure machine's decision after begin/submit/poll. Centralised so all three entry
  // points share one transition table.
  const applyNext = (kind: OnboardingProviderKind, next: LoginNext) => {
    switch (next.kind) {
      case "awaiting_token":
        patch(kind, {
          login: {
            phase: "awaiting_token",
            loginId: next.loginId,
            authorizationUrl: next.authorizationUrl
          }
        });
        return;
      case "awaiting_authorization":
        patch(kind, {
          login: {
            phase: "awaiting_authorization",
            loginId: next.loginId,
            authorizationUrl: next.authorizationUrl,
            ...(next.userCode !== undefined ? { userCode: next.userCode } : {})
          }
        });
        void pollLoop(kind, next.loginId, {
          authorizationUrl: next.authorizationUrl,
          ...(next.userCode !== undefined ? { userCode: next.userCode } : {})
        });
        return;
      case "no_url":
        patch(kind, { login: { phase: "no_url", loginId: next.loginId } });
        return;
      case "ready":
        patch(kind, { login: IDLE_LOGIN });
        refresh();
        return;
      case "error":
        patch(kind, { login: { phase: "idle", error: next.message } });
        return;
      case "poll":
        void pollLoop(kind, next.loginId);
        return;
    }
  };

  const pollLoop = async (
    kind: OnboardingProviderKind,
    loginId: string,
    surface?: Pick<LoginSession, "authorizationUrl" | "userCode">
  ) => {
    patch(kind, { login: { phase: "polling", loginId, ...surface } });
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await delay(POLL_INTERVAL_MS);
      let next: LoginNext;
      try {
        const resp = await pollOnboardingProviderLogin({ providerKind: kind, loginId });
        next = interpretLoginResponse(resp, "poll");
      } catch (error) {
        handleError(kind, error);
        return;
      }
      if (next.kind === "ready") {
        patch(kind, { login: IDLE_LOGIN });
        refresh();
        return;
      }
      if (next.kind === "error") {
        patch(kind, { login: { phase: "idle", error: next.message } });
        return;
      }
      // still awaiting — keep polling
    }
    patch(kind, { login: { phase: "idle", error: "Login timed out — try again." } });
  };

  const beginLogin = async (kind: OnboardingProviderKind) => {
    patch(kind, { login: { phase: "beginning" }, busy: false, error: undefined });
    try {
      const resp = await beginOnboardingProviderLogin({ providerKind: kind });
      applyNext(kind, interpretLoginResponse(resp, "begin"));
    } catch (error) {
      handleError(kind, error);
    }
  };

  // The single "Connect" button: install → (auto) login. install/login are one-at-a-time (#347).
  const connect = async (kind: OnboardingProviderKind) => {
    patch(kind, { installing: true, busy: false, error: undefined, login: IDLE_LOGIN });
    try {
      const resp = await installOnboardingProvider({ providerKind: kind });
      patch(kind, { installing: false });
      if (resp.installState === "error") {
        // Surface the error BEFORE refreshing status, so the message is shown even if the
        // background refetch races (it never depends on installState catching up).
        patch(kind, { error: resp.message ?? "Install failed. Try again." });
        refresh();
        return;
      }
      refresh();
      if (shouldAutoLogin(resp.installState)) {
        await beginLogin(kind);
      }
    } catch (error) {
      handleError(kind, error);
    }
  };

  const submitToken = async (kind: OnboardingProviderKind, code: string) => {
    const session = stateFor(kind).login;
    const loginId = session.loginId;
    if (!loginId || code.length === 0) return;
    // Drop the pasted code from state the instant it is captured for forwarding — BEFORE any
    // await — so it never lingers on ANY outcome (success, error-status, or a thrown request).
    patch(kind, {
      login: { ...session, phase: "submitting" },
      busy: false,
      error: undefined,
      token: ""
    });
    try {
      const resp = await submitOnboardingProviderLoginToken({
        providerKind: kind,
        loginId,
        token: code
      });
      applyNext(kind, interpretLoginResponse(resp, "submit"));
    } catch (error) {
      handleError(kind, error);
    }
  };

  const readyCount = props.step.providers.filter(
    (provider) => provider.installState === "ready"
  ).length;

  return (
    <section className="onb-step" aria-labelledby="onboarding-cli-title">
      <StepHeader
        eyebrow="Step 2 · Your provider"
        title="Connect your AI provider."
        lede={`Pick a provider and ${assistantName} installs it and signs you in — no terminal, no API keys. When it’s connected, chat is ready.`}
      />
      <div className="onb-scan">
        <span className="onb-scan__ic">
          <ShieldCheck size={18} aria-hidden="true" />
        </span>
        <div className="onb-scan__main">
          <div className="onb-scan__t">
            {readyCount > 0
              ? `${readyCount} provider${readyCount === 1 ? "" : "s"} connected · chat is ready`
              : "Connect a provider to start chatting"}
          </div>
        </div>
      </div>
      <div className="onb-clis">
        {props.step.providers.map((provider) => {
          const state = stateFor(provider.kind);
          const model = deriveCardModel({
            provider,
            login: state.login,
            installing: state.installing,
            busy: state.busy,
            errorMessage: state.error
          });
          return (
            <ProviderCard
              key={provider.kind}
              model={model}
              label={PROVIDER_LABELS[provider.kind] ?? provider.kind}
              assistantName={assistantName}
              onConnect={() => void connect(provider.kind)}
              onLogin={() => void beginLogin(provider.kind)}
              onSubmitToken={(code) => void submitToken(provider.kind, code)}
              tokenValue={state.token}
              onTokenChange={(value) => patch(provider.kind, { token: value })}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * Presentational, PURE-from-`model` provider card. All transition logic lives in CliAuthStep + the
 * connect machine; this only renders the derived CardModel. Exported so the render tests can drive
 * every visual state without a DOM (react-dom/server).
 */
export function ProviderCard(props: {
  readonly model: CardModel;
  readonly label: string;
  /** Defaults to "Moss" so existing callers (e.g. unit tests rendering this pure component
   *  standalone via react-dom/server) don't need to thread the live persona query through. */
  readonly assistantName: string;
  readonly onConnect: () => void;
  readonly onLogin: () => void;
  readonly onSubmitToken: (code: string) => void;
  readonly tokenValue: string;
  readonly onTokenChange: (value: string) => void;
}) {
  const { model, label, assistantName } = props;
  const ready = model.status === "ready";

  return (
    <div
      className={`onb-cli${model.status === "unavailable" ? " is-off" : ""}${ready ? " is-sel" : ""}`}
    >
      <span className="onb-cli__radio">
        {ready ? <CircleCheck size={12} strokeWidth={3} aria-hidden="true" /> : null}
      </span>
      <div className="onb-cli__body">
        <div className="onb-cli__top">
          <span className="onb-cli__name">{label}</span>
          <span className="onb-cli__sp" />
          <span className={`onb-detect onb-detect--${ready ? "on" : "off"}`}>
            {ready ? (
              <CircleCheck size={13} aria-hidden="true" />
            ) : (
              <CircleDashed size={13} aria-hidden="true" />
            )}
            {ready ? "Connected" : statusBadge(model.status)}
          </span>
        </div>

        <div className="onb-auth">
          {/* Error is ORTHOGONAL to status: a login/connect failure leaves installState at
              needs_login while surfacing an errorMessage. Render it for ANY status (like busy) so
              a failure is never silently swallowed — the status-specific button below acts as the
              retry (Connect / Log in / Try again). */}
          {model.errorMessage ? (
            <div className="onb-auth__err" role="alert">
              <Info size={14} aria-hidden="true" /> {model.errorMessage}
            </div>
          ) : null}

          {model.status === "unavailable" ? (
            <span className="onb-auth__note">
              <Info size={14} aria-hidden="true" /> {label} isn’t available to install on this build
              yet.
            </span>
          ) : null}

          {model.status === "not_installed" ? (
            <>
              <button
                className="onb-auth__btn"
                type="button"
                disabled={model.busy}
                onClick={props.onConnect}
              >
                <LogIn size={14} aria-hidden="true" /> Connect
              </button>
              <span className="onb-auth__note">Installs {label} and signs you in · ~30–90s.</span>
            </>
          ) : null}

          {model.status === "installing" ? (
            <span className="onb-auth__testing">
              <LoaderCircle className="spin" size={14} aria-hidden="true" /> Installing… ~30–90s
            </span>
          ) : null}

          {model.status === "needs_login" ? (
            <button
              className="onb-auth__btn"
              type="button"
              disabled={model.busy}
              onClick={props.onLogin}
            >
              <LogIn size={14} aria-hidden="true" /> Log in
            </button>
          ) : null}

          {model.status === "logging_in" ? (
            model.userCode && model.authorizationUrl ? (
              <div className="onb-auth__outwrap">
                <div className="onb-auth__hint">
                  Open the sign-in page and enter this device code. {assistantName} will detect when
                  you’re finished.
                </div>
                <div className="onb-auth__outhd">
                  <a
                    className="onb-cli__guide"
                    href={model.authorizationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open sign-in page <ExternalLink size={12} aria-hidden="true" />
                  </a>
                  <button
                    className="onb-auth__re"
                    type="button"
                    onClick={() => void copyText(model.userCode ?? "")}
                  >
                    <Copy size={12} aria-hidden="true" /> Copy code
                  </button>
                </div>
                <code>{model.userCode}</code>
              </div>
            ) : model.awaitingToken && model.authorizationUrl ? (
              <div className="onb-auth__outwrap">
                <div className="onb-auth__hint">
                  Open the sign-in page, approve access, then paste the code it gives you.
                </div>
                <div className="onb-auth__outhd">
                  <a
                    className="onb-cli__guide"
                    href={model.authorizationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open sign-in page <ExternalLink size={12} aria-hidden="true" />
                  </a>
                  <button
                    className="onb-auth__re"
                    type="button"
                    onClick={() => void copyText(model.authorizationUrl ?? "")}
                  >
                    <Copy size={12} aria-hidden="true" /> Copy link
                  </button>
                </div>
                <div className="onb-auth__paste">
                  <input
                    className="onb-auth__code"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    placeholder="Paste the code here"
                    aria-label={`Paste the ${label} sign-in code`}
                    value={props.tokenValue}
                    onChange={(event) => props.onTokenChange(event.target.value)}
                  />
                  <button
                    className="onb-auth__btn"
                    type="button"
                    disabled={model.busy || props.tokenValue.length === 0}
                    onClick={() => props.onSubmitToken(props.tokenValue)}
                  >
                    Submit
                  </button>
                </div>
              </div>
            ) : (
              <span className="onb-auth__testing">
                <LoaderCircle className="spin" size={14} aria-hidden="true" /> Signing in…
              </span>
            )
          ) : null}

          {model.status === "no_login" ? (
            <span className="onb-auth__note">
              <Info size={14} aria-hidden="true" /> Login isn’t available headless yet for {label}.
              You can skip this and finish setup.
            </span>
          ) : null}

          {ready ? (
            <span className="onb-auth__res onb-auth__res--in">
              <ShieldCheck size={14} aria-hidden="true" /> Connected · chat ready
            </span>
          ) : null}

          {model.status === "error" ? (
            <button className="onb-auth__btn" type="button" onClick={props.onConnect}>
              Try again
            </button>
          ) : null}

          {model.busy ? (
            <span className="onb-auth__busy">
              <Info size={14} aria-hidden="true" /> Setup is busy — another install or sign-in is in
              progress. Try again in a moment.
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function statusBadge(status: CardModel["status"]): string {
  switch (status) {
    case "unavailable":
      return "Not available";
    case "installing":
      return "Installing";
    case "needs_login":
      return "Installed";
    case "logging_in":
      return "Signing in";
    case "no_login":
      return "Login unavailable";
    case "error":
      return "Needs attention";
    default:
      return "Not connected";
  }
}
