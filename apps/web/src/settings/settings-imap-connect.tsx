import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ExternalLink, KeyRound, Mail, Server } from "lucide-react";
import { useState } from "react";

import { findImapProviderIdForEmail } from "@moss/shared";
import { Button } from "@moss/ui";
import { connectImapConnection, testImapConnection } from "../api/client";
import { GOOGLE_CONNECT_SUCCESS_QUERY_KEYS } from "../connectors/use-google-connect-flow";
import { IMAP_PROVIDERS, type ImapProvider } from "../onboarding/google-connector-step";
import { useFeedback } from "./settings-feedback";

function imapResultCopy(result: string): string {
  if (result === "ok") return "Connection works.";
  if (result === "auth_failed") return "The mail server rejected that username or password.";
  if (result === "tls_failed") return "Could not establish a secure connection.";
  return "Could not reach the mail server.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Connection failed.";
}

function providerById(id: string | null): ImapProvider | null {
  return IMAP_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** One-line description of the mail server a preset will connect to. */
export function serverSummary(provider: ImapProvider): string {
  const security = provider.server.tls ? "encrypted" : "no encryption, local Bridge only";
  return `${provider.server.host}, port ${provider.server.port} (${security})`;
}

export const GENERIC_SERVER_HINT =
  "We do not have setup notes for this address yet. Choose the service that hosts your mail; the server settings come from that choice.";

export const GENERIC_PASSWORD_HINT =
  "Most mail services need an app password made for this connection rather than your normal sign-in password.";

/* Settings-surface twin of the onboarding IMAP flow (google-connector-step.tsx) — same
   provider list, same testImapConnection/connectImapConnection API layer, same success
   query-key invalidation, since accounts.done is shared between onboarding and settings.
   Unlike onboarding, this flow asks for the email address first and recognises the
   provider from its domain (findImapProviderIdForEmail); the user can still pick or
   override the service by hand. */
export function ImapConnect(props: {
  readonly onBack: () => void;
  readonly initialProvider?: ImapProvider;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The service the user chose by hand; null means "follow whatever the address suggests".
  const [chosenProviderId, setChosenProviderId] = useState<string | null>(
    props.initialProvider?.id ?? null
  );
  const [testResult, setTestResult] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useFeedback();

  const detectedProviderId = findImapProviderIdForEmail(username);
  const provider = providerById(chosenProviderId ?? detectedProviderId);
  const recognised = chosenProviderId === null && provider !== null;

  const credsReady = username.trim().length > 0 && password.length > 0;
  const ready = credsReady && provider !== null;

  const testImap = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Choose which service hosts this address first.");
      return testImapConnection({ providerId: provider.id, username, password });
    },
    onSuccess: ({ result }) => setTestResult(imapResultCopy(result))
  });

  const connectImap = useMutation({
    mutationFn: () => {
      if (!provider) throw new Error("Choose which service hosts this address first.");
      return connectImapConnection({ providerId: provider.id, username, password });
    },
    onSuccess: () =>
      Promise.all(
        GOOGLE_CONNECT_SUCCESS_QUERY_KEYS.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey })
        )
      ).then(() => {
        toast(`Connected ${provider?.name ?? "email"} — messages are syncing`, {
          icon: <Check size={17} />
        });
        props.onBack();
      }),
    onError: (error) => toast(errorMessage(error), { tone: "drift" })
  });

  return (
    <div className="imapflow">
      <button type="button" className="gflow__back" onClick={props.onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        All accounts
      </button>
      <div className="gflow__intro">
        <span className="gflow__g">
          <Mail size={18} aria-hidden="true" />
        </span>
        <div className="gflow__introtx">
          <div className="gflow__title">Add an email account</div>
          <div className="gflow__sub">IMAP email sync</div>
        </div>
      </div>
      <div className="onb-cred">
        <div className="onb-cred__hd">Enter your email credentials</div>
        <label className="onb-cred__field">
          <span className="onb-cred__lbl">Email address</span>
          <span className="onb-cred__in">
            <span className="ic">
              <Mail size={15} aria-hidden="true" />
            </span>
            <input
              type="email"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setTestResult(null);
              }}
              placeholder="you@example.com"
              spellCheck={false}
              aria-label="Email address"
            />
          </span>
        </label>
        <label className="onb-cred__field">
          <span className="onb-cred__lbl">Mail service</span>
          <span className="onb-cred__in">
            <span className="ic">
              <Server size={15} aria-hidden="true" />
            </span>
            <select
              value={provider?.id ?? ""}
              onChange={(event) => {
                setChosenProviderId(event.target.value || null);
                setTestResult(null);
              }}
              aria-label="Mail service"
            >
              <option value="">Choose the service that hosts this address</option>
              {IMAP_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
          <span className="onb-cred__hint" data-hint="server">
            {provider
              ? `${recognised ? "Recognised from your email address. " : ""}Mail server: ${serverSummary(provider)}.`
              : GENERIC_SERVER_HINT}
          </span>
        </label>
        <label className="onb-cred__field">
          <span className="onb-cred__lbl">App password</span>
          <span className="onb-cred__in">
            <span className="ic">
              <KeyRound size={15} aria-hidden="true" />
            </span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={provider ? `${provider.name} app password` : "App password"}
              spellCheck={false}
              aria-label="App password"
            />
          </span>
          <span className="onb-cred__hint" data-hint="password">
            {provider ? (
              <>
                {provider.prerequisite} {provider.steps.join(" ")}{" "}
                <a
                  className="onb-guide__link"
                  href={provider.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {provider.name} setup guide <ExternalLink size={12} aria-hidden="true" />
                </a>
              </>
            ) : (
              GENERIC_PASSWORD_HINT
            )}
          </span>
        </label>
        <div className="onb-cred__actions">
          <Button
            variant="quiet"
            size="sm"
            disabled={!ready || testImap.isPending}
            onClick={() => testImap.mutate()}
          >
            Test connection
          </Button>
          <Button
            size="sm"
            disabled={!ready || connectImap.isPending}
            onClick={() => connectImap.mutate()}
          >
            {provider ? `Connect ${provider.name}` : "Connect"}
          </Button>
          <Button variant="quiet" size="sm" onClick={props.onBack}>
            Cancel
          </Button>
          <span className="onb-cred__hint">
            Passwords are encrypted at rest and never shown in logs or briefings.
          </span>
        </div>
        {testResult ? <p className="gflow__p">{testResult}</p> : null}
        {testImap.error ? <p className="form-error">{errorMessage(testImap.error)}</p> : null}
        {connectImap.error ? <p className="form-error">{errorMessage(connectImap.error)}</p> : null}
      </div>
    </div>
  );
}
