import { ExternalLink, Info, LoaderCircle, LogIn, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button, Dialog } from "@moss/ui";
import type { AiProviderConfigDto, AiProviderKind } from "@moss/shared";

import { ApiError } from "../api/client";
import {
  beginOnboardingProviderLogin,
  cancelOnboardingProviderLogin,
  pollOnboardingProviderLogin,
  submitOnboardingProviderLoginToken
} from "../api/onboarding-connect-client";
import { useAssistantName } from "../api/use-assistant-name";

// #2027 added google: the Gemini command-line tool now has a sign-in adapter on the server, so the
// dialog can drive its link-and-paste flow like the other two.
export type AutomatedLoginProviderKind = Extract<
  AiProviderKind,
  "anthropic" | "openai-compatible" | "google"
>;

export type AutomatedLoginProvider = AiProviderConfigDto & {
  readonly providerKind: AutomatedLoginProviderKind;
};

type LoginPhase =
  | "beginning"
  | "awaiting-token"
  | "awaiting-authorization"
  | "submitting"
  | "polling"
  | "success"
  | "error";

interface LoginState {
  readonly phase: LoginPhase;
  readonly loginId?: string;
  readonly authorizationUrl?: string;
  readonly userCode?: string;
  readonly token: string;
  readonly error?: string;
}

const MAX_POLLS = 360; // nine minutes, just below the runner's ten-minute login lifetime
const POLL_INTERVAL_MS = 1500;

const INITIAL_STATE: LoginState = { phase: "beginning", token: "" };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

export function supportsAutomatedProviderLogin(
  provider: AiProviderConfigDto
): provider is AutomatedLoginProvider {
  return (
    provider.authMethod === "cli" &&
    provider.cliAvailable &&
    (provider.providerKind === "anthropic" ||
      provider.providerKind === "openai-compatible" ||
      provider.providerKind === "google")
  );
}

export function ProviderLoginDialog(props: {
  readonly provider: AutomatedLoginProvider;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}) {
  const { provider, onSuccess } = props;
  const assistantName = useAssistantName();
  const [state, setState] = useState<LoginState>(INITIAL_STATE);
  const closedRef = useRef(false);
  const sessionRef = useRef<{ providerKind: AutomatedLoginProviderKind; loginId: string } | null>(
    null
  );
  // #2232: React's StrictMode runs the mount effect, its cleanup, then the effect again, all
  // before the first "begin" request comes back. Without a guard that fires two begin requests
  // in the same instant — the first gets cancelled by the cleanup, the second is refused by the
  // server because a login is already active. This ref makes sure only one begin ever starts per
  // time the dialog is opened; the StrictMode replay just reuses it.
  const beganRef = useRef(false);
  const deferredCancelRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback(() => {
    sessionRef.current = null;
    setState((current) => ({ ...current, phase: "success", token: "" }));
    onSuccess();
  }, [onSuccess]);

  const pollLogin = useCallback(
    async (loginId: string) => {
      setState((current) => ({ ...current, phase: "polling", loginId }));
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        await delay(POLL_INTERVAL_MS);
        if (closedRef.current) return;
        try {
          const response = await pollOnboardingProviderLogin({
            providerKind: provider.providerKind,
            loginId,
            providerConfigId: provider.id
          });
          if (response.status === "ready") {
            finish();
            return;
          }
          if (response.status === "error") {
            setState((current) => ({
              ...current,
              phase: "error",
              error: response.message ?? "Login failed.",
              token: ""
            }));
            return;
          }
          setState((current) => ({
            ...current,
            phase: "polling",
            authorizationUrl: response.authorizationUrl ?? current.authorizationUrl,
            userCode: response.userCode ?? current.userCode
          }));
        } catch (error) {
          setState((current) => ({
            ...current,
            phase: "error",
            error: errorText(error),
            token: ""
          }));
          return;
        }
      }
      setState((current) => ({
        ...current,
        phase: "error",
        error: "Login timed out — try again.",
        token: ""
      }));
    },
    [finish, provider.providerKind]
  );

  const beginLogin = useCallback(async () => {
    setState({ phase: "beginning", token: "" });
    try {
      // #2205: name the clicked row so the server reactivates it instead of adding a duplicate.
      const response = await beginOnboardingProviderLogin({
        providerKind: provider.providerKind,
        providerConfigId: provider.id
      });
      if (closedRef.current) {
        void cancelOnboardingProviderLogin({
          providerKind: provider.providerKind,
          loginId: response.loginId
        });
        return;
      }
      sessionRef.current = { providerKind: provider.providerKind, loginId: response.loginId };
      if (response.status === "ready") {
        finish();
        return;
      }
      if (response.status === "error") {
        setState({ phase: "error", loginId: response.loginId, token: "", error: response.message });
        return;
      }
      setState({
        phase: response.status === "awaiting_token" ? "awaiting-token" : "awaiting-authorization",
        loginId: response.loginId,
        authorizationUrl: response.authorizationUrl,
        userCode: response.userCode,
        token: ""
      });
      if (response.status === "awaiting_authorization") void pollLogin(response.loginId);
    } catch (error) {
      if (!closedRef.current) setState({ phase: "error", token: "", error: errorText(error) });
    }
  }, [finish, pollLogin, provider.providerKind]);

  useEffect(() => {
    closedRef.current = false;
    // A real remount (this same open, replayed by StrictMode) cancels the deferred cleanup below
    // instead of letting it fire, so the in-flight or completed begin is kept, not restarted.
    if (deferredCancelRef.current !== null) {
      clearTimeout(deferredCancelRef.current);
      deferredCancelRef.current = null;
    }
    if (!beganRef.current) {
      beganRef.current = true;
      void beginLogin();
    }
    return () => {
      closedRef.current = true;
      // Delay the actual cancel by a tick: if this was only the StrictMode replay, the effect
      // above runs again immediately and clears this timer before it fires. If the dialog is
      // truly unmounting, nothing clears it and the session is cancelled as before.
      deferredCancelRef.current = setTimeout(() => {
        deferredCancelRef.current = null;
        const session = sessionRef.current;
        sessionRef.current = null;
        if (session) void cancelOnboardingProviderLogin(session);
      }, 0);
    };
  }, [beginLogin]);

  const close = () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) void cancelOnboardingProviderLogin(session);
    props.onClose();
  };

  const submitToken = async () => {
    const loginId = state.loginId;
    const token = state.token;
    if (!loginId || !token) return;
    // Clear auth material before the request starts; it must not linger on success or failure.
    setState((current) => ({ ...current, phase: "submitting", token: "", error: undefined }));
    try {
      const response = await submitOnboardingProviderLoginToken({
        providerKind: provider.providerKind,
        loginId,
        token,
        providerConfigId: provider.id
      });
      if (response.status === "ready") {
        finish();
      } else if (response.status === "error") {
        setState((current) => ({
          ...current,
          phase: "error",
          error: response.message ?? "Login failed."
        }));
      } else {
        void pollLogin(loginId);
      }
    } catch (error) {
      if (!closedRef.current) {
        setState((current) => ({ ...current, phase: "error", error: errorText(error) }));
      }
    }
  };

  const copyUrl = () => {
    if (state.authorizationUrl) void navigator.clipboard?.writeText(state.authorizationUrl);
  };
  const busy = state.phase === "beginning" || state.phase === "submitting";
  const titleId = useId();

  return (
    <Dialog
      onClose={() => {
        if (!busy) close();
      }}
      aria-labelledby={titleId}
      title={<span id={titleId}>Sign in to {provider.displayName}</span>}
      description="Complete the provider sign-in here; no terminal session or API key is required."
      footer={
        <>
          <Button variant="quiet" onClick={close} disabled={busy}>
            <X size={14} aria-hidden="true" /> Close
          </Button>
          {state.phase === "awaiting-token" ? (
            <Button onClick={() => void submitToken()} disabled={!state.token || !state.loginId}>
              <LogIn size={14} aria-hidden="true" /> Submit code
            </Button>
          ) : null}
        </>
      }
    >
      {state.phase === "beginning" || state.phase === "submitting" ? (
        <div className="term-modal__prompt">
          <LoaderCircle size={16} className="dexp__spin" aria-hidden="true" />
          {state.phase === "beginning" ? "Starting sign-in…" : "Completing sign-in…"}
        </div>
      ) : null}

      {state.phase === "awaiting-token" ? (
        <>
          <div className="term-modal__prompt">Approve access, then paste the code below.</div>
          {state.authorizationUrl ? (
            <p>
              <a href={state.authorizationUrl} target="_blank" rel="noreferrer">
                Open provider sign-in <ExternalLink size={13} aria-hidden="true" />
              </a>{" "}
              <Button variant="quiet" size="sm" onClick={copyUrl}>
                Copy link
              </Button>
            </p>
          ) : null}
          <input
            className="jds-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            placeholder="Paste sign-in code"
            aria-label="Provider sign-in code"
            value={state.token}
            onChange={(event) => setState((current) => ({ ...current, token: event.target.value }))}
          />
        </>
      ) : null}

      {state.phase === "awaiting-authorization" || state.phase === "polling" ? (
        <>
          <div className="term-modal__prompt">
            <LoaderCircle size={16} className="dexp__spin" aria-hidden="true" />
            Approve access in the provider page; {assistantName} is checking for completion.
          </div>
          {state.authorizationUrl ? (
            <p>
              <a href={state.authorizationUrl} target="_blank" rel="noreferrer">
                Open provider sign-in <ExternalLink size={13} aria-hidden="true" />
              </a>{" "}
              <Button variant="quiet" size="sm" onClick={copyUrl}>
                Copy link
              </Button>
            </p>
          ) : null}
          {state.userCode ? (
            <p>
              Device code: <code>{state.userCode}</code>
            </p>
          ) : null}
        </>
      ) : null}

      {state.phase === "error" ? (
        <div role="alert">
          <p>
            <Info size={15} aria-hidden="true" /> {state.error ?? "Login failed."}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void beginLogin()}>
            Try again
          </Button>
        </div>
      ) : null}

      {state.phase === "success" ? <p role="status">Provider connected. Chat is ready.</p> : null}
    </Dialog>
  );
}
