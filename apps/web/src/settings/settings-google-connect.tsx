import {
  ArrowLeft,
  Check,
  ExternalLink,
  Fingerprint,
  KeyRound,
  Link2,
  Monitor,
  ShieldCheck,
  Upload
} from "lucide-react";
import { useState } from "react";
import type { ChangeEvent, ReactNode } from "react";

import { useAssistantName } from "../api/use-assistant-name";
import { importCredentialsJson } from "../connectors/google-credentials";
import { useGoogleConnectFlow } from "../connectors/use-google-connect-flow";
import { useFeedback } from "./settings-feedback";
import { Button } from "@moss/ui";

/* Credential / paste field, matched to the onboarding Google walkthrough. */
function CredField(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly type?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly ok?: boolean;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}) {
  return (
    <div className="onb-cred__field">
      <span className="onb-cred__lbl">{props.label}</span>
      <div className="onb-cred__in">
        <span className="ic">{props.icon}</span>
        <input
          type={props.type ?? "text"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          spellCheck={false}
          aria-label={props.ariaLabel}
          disabled={props.disabled}
        />
        {props.ok ? (
          <span className="onb-cred__ok">
            <Check size={15} aria-hidden="true" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* The developer paste-in Google connect — the real flow, end to end: build your
   own OAuth app, paste credentials, authorize, paste the localhost redirect back
   to finish the token exchange. Wired to the existing useGoogleConnectFlow. */
export function GoogleConnect(props: { readonly onBack: () => void }) {
  const [jsonImportStatus, setJsonImportStatus] = useState<string | null>(null);
  const { toast } = useFeedback();
  const assistantName = useAssistantName();
  const google = useGoogleConnectFlow({
    onConnected: () => {
      toast("Connected Google — calendar and email are syncing", { icon: <Check size={17} /> });
      props.onBack();
    },
    onError: (message) => toast(message, { tone: "drift" })
  });

  const cidOk = google.clientId.trim().length > 8;
  const csecOk = google.clientSecret.trim().length > 6;
  const credsReady = cidOk && csecOk;
  const authorized = Boolean(google.authUrl);
  const redirOk = /localhost(:\d+)?/i.test(google.redirectUrl) && /code=/.test(google.redirectUrl);
  const finishReady = credsReady && authorized && redirOk && !google.completionPending;

  const handleCredentialsJsonImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const result = await importCredentialsJson(event);
    if (!result) return;
    if ("error" in result) {
      setJsonImportStatus(result.error);
      return;
    }
    google.setClientId(result.clientId);
    google.setClientSecret(result.clientSecret);
    setJsonImportStatus("Credentials imported from JSON.");
  };

  return (
    <div className="gflow">
      <button type="button" className="gflow__back" onClick={props.onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        All accounts
      </button>
      <div className="gflow__intro">
        <span className="gflow__g">G</span>
        <div className="gflow__introtx">
          <div className="gflow__title">Connect Google</div>
        </div>
      </div>

      <div className="gflow__card">
        <div className="onb-guide__intro">
          <span className="ic">
            <ShieldCheck size={15} aria-hidden="true" />
          </span>
          <span>
            {assistantName} reaches Google through <b>an OAuth app you own</b>, so your calendar and
            email never pass through anyone else's servers. You build it once and paste two values.
          </span>
        </div>

        <ol className="onb-guide">
          <li className="onb-guide__step">
            <span className="onb-guide__n">1</span>
            <div className="onb-guide__body">
              <div className="onb-guide__t">
                Open the <b>Google Cloud Console</b> and create a project — or pick one you already
                have.
              </div>
              <a
                className="onb-guide__link"
                href="https://console.cloud.google.com/projectcreate"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open console{" "}
                <span className="ic">
                  <ExternalLink size={13} aria-hidden="true" />
                </span>
              </a>
            </div>
          </li>
          <li className="onb-guide__step">
            <span className="onb-guide__n">2</span>
            <div className="onb-guide__body">
              <div className="onb-guide__t">
                Enable the <b>Gmail API</b> and the <b>Google Calendar API</b> for that project.
              </div>
              <div className="gflow__links">
                <a
                  className="onb-guide__link"
                  href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Enable Gmail API{" "}
                  <span className="ic">
                    <ExternalLink size={13} aria-hidden="true" />
                  </span>
                </a>
                <a
                  className="onb-guide__link"
                  href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Enable Calendar API{" "}
                  <span className="ic">
                    <ExternalLink size={13} aria-hidden="true" />
                  </span>
                </a>
              </div>
            </div>
          </li>
          <li className="onb-guide__step">
            <span className="onb-guide__n">3</span>
            <div className="onb-guide__body">
              <div className="onb-guide__t">
                Set up the <b>OAuth consent screen</b>: choose <b>External</b>, then add your own
                Google address as a test user.
              </div>
            </div>
          </li>
          <li className="onb-guide__step">
            <span className="onb-guide__n">4</span>
            <div className="onb-guide__body">
              <div className="onb-guide__t">
                Go to <b>Credentials → Create credentials → OAuth client ID</b>. For{" "}
                <b>Application type</b>, pick{" "}
                <span className="onb-guide__pill">
                  <Monitor size={12} aria-hidden="true" /> Desktop app
                </span>
                .
              </div>
              <a
                className="onb-guide__link"
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open credentials{" "}
                <span className="ic">
                  <ExternalLink size={13} aria-hidden="true" />
                </span>
              </a>
            </div>
          </li>
        </ol>

        <div className="onb-cred">
          <div className="onb-cred__hd">1 · Paste your client credentials</div>
          <label className="onb-json-upload">
            <input
              type="file"
              accept="application/json,.json"
              onChange={handleCredentialsJsonImport}
            />
            <span className="onb-json-upload__icon">
              <Upload size={15} aria-hidden="true" />
            </span>
            <span className="onb-json-upload__main">
              <span className="onb-json-upload__title">Or upload your Google client JSON file</span>
              <span className="onb-json-upload__sub">
                We will extract the client ID and client secret automatically.
              </span>
            </span>
          </label>
          {jsonImportStatus ? (
            <div className="onb-json-upload__status">{jsonImportStatus}</div>
          ) : null}
          <CredField
            label="Client ID"
            icon={<Fingerprint size={15} aria-hidden="true" />}
            value={google.clientId}
            onChange={google.setClientId}
            placeholder="000000-xxxx.apps.googleusercontent.com"
            ok={cidOk}
            ariaLabel="Google client ID"
          />
          <CredField
            label="Client secret"
            icon={<KeyRound size={15} aria-hidden="true" />}
            type="password"
            value={google.clientSecret}
            onChange={google.setClientSecret}
            placeholder="GOCSPX-…"
            ok={csecOk}
            ariaLabel="Google client secret"
          />
          <div className="onb-cred__hint">Stored encrypted on this server.</div>
        </div>

        <div className="onb-cred gflow__phase">
          <div className="onb-cred__hd">2 · Authorize {assistantName}</div>
          <p className="gflow__p">
            Open Google's consent screen, sign in, and grant access. Google then redirects to a{" "}
            <code>http://localhost:1/…</code> address that won't load — <strong>that's expected</strong>.
          </p>
          <div className="gflow__authrow">
            {authorized ? (
              <a
                className="onb-guide__link gflow__authlink"
                href={google.authUrl ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open consent screen{" "}
                <span className="ic">
                  <ExternalLink size={13} aria-hidden="true" />
                </span>
              </a>
            ) : (
              <button
                type="button"
                className={`onb-guide__link gflow__authlink${credsReady ? "" : " is-disabled"}`}
                disabled={!credsReady || google.authorizationPending}
                onClick={google.openConsentScreen}
              >
                Open consent screen{" "}
                <span className="ic">
                  <ExternalLink size={13} aria-hidden="true" />
                </span>
              </button>
            )}
            {authorized ? (
              <span className="gflow__ok">
                <Check size={13} aria-hidden="true" />
                Consent screen ready
              </span>
            ) : !credsReady ? (
              <span className="gflow__wait">Paste your credentials first</span>
            ) : google.authorizationPending ? (
              <span className="gflow__wait">Preparing…</span>
            ) : google.popupBlocked ? (
              <span className="gflow__wait">
                Your browser blocked the popup — allow popups for this site and try again.
              </span>
            ) : null}
          </div>
        </div>

        <div className="onb-cred gflow__phase">
          <div className="onb-cred__hd">3 · Finish the connection</div>
          <p className="gflow__p">
            After approving, copy the full address from your browser's bar — it starts with{" "}
            <code>http://localhost:1/</code> — and paste it here to complete the token exchange.
          </p>
          <CredField
            label="Redirect URL"
            icon={<Link2 size={15} aria-hidden="true" />}
            value={google.redirectUrl}
            onChange={google.setRedirectUrl}
            placeholder="http://localhost:1/?code=4/0Ab…&scope=…"
            ok={redirOk}
            ariaLabel="Pasted redirect URL"
            disabled={!authorized}
          />
          <div className="onb-cred__actions">
            <Button size="sm" disabled={!finishReady} onClick={google.finishConnection}>
              Finish connection
            </Button>
            <Button variant="quiet" size="sm" onClick={props.onBack}>
              Cancel
            </Button>
            <span className="onb-cred__hint">
              {finishReady
                ? "Looks good — completing the token exchange."
                : "Authorize first, then paste the redirect you land on."}
            </span>
          </div>
          {google.error ? <div className="gflow__err">{google.error}</div> : null}
        </div>
      </div>
    </div>
  );
}
