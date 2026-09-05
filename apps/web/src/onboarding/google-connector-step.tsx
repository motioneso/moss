import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  ExternalLink,
  Fingerprint,
  KeyRound,
  Link2,
  Mail,
  Monitor,
  Plus,
  ShieldCheck,
  Upload
} from "lucide-react";
import type { ChangeEvent } from "react";
import { Button, ButtonLink } from "@moss/ui";

import {
  connectImapConnection,
  listConnectorAccounts,
  revokeConnectorAccount,
  testImapConnection
} from "../api/client";
import { useAssistantName } from "../api/use-assistant-name";
import { queryKeys } from "../api/query-keys";
import {
  GOOGLE_CONNECT_SUCCESS_QUERY_KEYS,
  useGoogleConnectFlow
} from "../connectors/use-google-connect-flow";
import { importCredentialsJson } from "../connectors/google-credentials";

import { FootNote, StepHeader } from "./onboarding-ui";

/* `server` mirrors the display-only half of the backend preset (@moss/connectors/presets) so
   the settings flow can show which mail server a recognised address will use; the API still
   resolves host/port/TLS from `id`. tests/unit/settings-imap-connect.test.tsx asserts the two
   stay in step. */
export const IMAP_PROVIDERS = [
  {
    id: "imap-yahoo",
    name: "Yahoo Mail",
    tile: "Y",
    server: { host: "imap.mail.yahoo.com", port: 993, tls: true },
    prerequisite:
      "Generate an app password in Yahoo Account Security; your normal password will not work.",
    steps: [
      'Sign in at Yahoo Account Security and select "Create app password."',
      'Name it, then select "Generate password."',
      "Copy the one-time password Yahoo shows."
    ],
    helpUrl: "https://help.yahoo.com/kb/SLN15241.html"
  },
  {
    id: "imap-proton",
    name: "Proton Mail",
    tile: "P",
    server: { host: "127.0.0.1", port: 1143, tls: false },
    prerequisite:
      "Requires a paid Proton plan with Proton Mail Bridge installed and running on or reachable from this host.",
    steps: [
      "Install Proton Mail Bridge and sign in with your Proton account.",
      "Let Bridge generate local IMAP credentials for this host.",
      "Copy the username and password Bridge shows."
    ],
    helpUrl: "https://proton.me/support/protonmail-bridge-install"
  },
  {
    id: "imap-icloud",
    name: "iCloud",
    tile: "i",
    server: { host: "imap.mail.me.com", port: 993, tls: true },
    prerequisite: "Generate an app-specific password at appleid.apple.com.",
    steps: [
      "Sign in at appleid.apple.com and open Sign-In and Security.",
      'Choose "App-Specific Passwords" and generate a new one.',
      "Copy the generated password."
    ],
    helpUrl: "https://support.apple.com/en-us/102654"
  },
  {
    id: "imap-fastmail",
    name: "Fastmail",
    tile: "F",
    server: { host: "imap.fastmail.com", port: 993, tls: true },
    prerequisite: "Generate an app password in Fastmail Settings > Privacy & Security.",
    steps: [
      "In Fastmail, go to Settings > Privacy & Security.",
      'Under "Connected apps & API tokens," select "New app password."',
      'Choose "Mail, Contacts & Calendars" access and generate it.'
    ],
    helpUrl: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords"
  }
] as const;

export type ImapProvider = (typeof IMAP_PROVIDERS)[number];

export function GoogleConnectorStep(props: {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede: string;
  readonly privacy: string;
  readonly done?: boolean;
}) {
  const assistantName = useAssistantName();
  const [mode, setMode] = useState<"picker" | "connecting" | "imap" | "connected" | "adding">(
    props.done ? "connected" : "picker"
  );
  const [imapProvider, setImapProvider] = useState<ImapProvider>(IMAP_PROVIDERS[0]);
  const [imapUsername, setImapUsername] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [imapTestResult, setImapTestResult] = useState<string | null>(null);
  const [jsonImportStatus, setJsonImportStatus] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const accountsQuery = useQuery({
    queryKey: queryKeys.connectors.accounts,
    queryFn: () => listConnectorAccounts(),
    retry: false
  });
  const google = useGoogleConnectFlow({
    onConnected: () => setMode("connected")
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeConnectorAccount(id),
    // Symmetric to connect: disconnecting the last Google account flips connectors.done back to
    // false, so refresh the onboarding status too — else the recap wrongly stays "connected".
    onSuccess: () =>
      Promise.all(
        GOOGLE_CONNECT_SUCCESS_QUERY_KEYS.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey })
        )
      )
  });
  const imapInput = {
    providerId: imapProvider.id,
    username: imapUsername,
    password: imapPassword
  };
  const imapReady = imapUsername.trim().length > 0 && imapPassword.length > 0;
  const testImap = useMutation({
    mutationFn: () => testImapConnection(imapInput),
    onSuccess: ({ result }) =>
      setImapTestResult(
        result === "ok"
          ? "Connection works."
          : result === "auth_failed"
            ? "The mail server rejected that username or password."
            : result === "tls_failed"
              ? "Could not establish a secure connection."
              : "Could not reach the mail server."
      )
  });
  const connectImap = useMutation({
    mutationFn: () => connectImapConnection(imapInput),
    onSuccess: () =>
      Promise.all(
        GOOGLE_CONNECT_SUCCESS_QUERY_KEYS.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey })
        )
      ).then(() => {
        setImapUsername("");
        setImapPassword("");
        setImapTestResult(null);
        setMode("connected");
      })
  });
  const accounts = accountsQuery.data?.accounts ?? [];
  const connected = props.done || accounts.length > 0;
  const cidOk = google.clientId.trim().length > 8;
  const csecOk = google.clientSecret.trim().length > 6;
  const credsReady = cidOk && csecOk;
  const redirectReady =
    google.authUrl !== null &&
    /localhost(:\d+)?/i.test(google.redirectUrl) &&
    /code=/.test(google.redirectUrl);

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

  if (mode === "connecting") {
    return (
      <section className="onb-step" aria-labelledby="google-connector-title">
        <StepHeader eyebrow={props.eyebrow} title={props.title} lede={props.lede} />
        <div className="onb-connector">
          <div className="onb-connector__head">
            <span className="onb-connector__g">G</span>
            <div className="onb-connector__t">
              <div className="onb-connector__title">Connect with your own Google app</div>
              <div className="onb-connector__sub">A one-time setup. About two minutes.</div>
            </div>
          </div>
          <div className="onb-guide__intro">
            <span className="ic">
              <ShieldCheck size={15} aria-hidden="true" />
            </span>
            <span>
              {assistantName} connects to Google using an OAuth application under your control. This
              ensures your calendar and email data never pass through third-party servers. You only
              need to set this up once and copy two values.
            </span>
          </div>
          <ol className="onb-guide">
            <li className="onb-guide__step">
              <span className="onb-guide__n">1</span>
              <div className="onb-guide__body">
                <div className="onb-guide__t">
                  Open the <b>Google Cloud Console</b> and create or select a project.
                </div>
                <a
                  className="onb-guide__link"
                  href="https://console.cloud.google.com/projectcreate"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open console <ExternalLink size={13} aria-hidden="true" />
                </a>
              </div>
            </li>
            <li className="onb-guide__step">
              <span className="onb-guide__n">2</span>
              <div className="onb-guide__body">
                <div className="onb-guide__t">
                  Enable the <b>Gmail API</b> and <b>Google Calendar API</b>, then add your email as
                  a test user on the OAuth consent screen.
                </div>
              </div>
            </li>
            <li className="onb-guide__step">
              <span className="onb-guide__n">3</span>
              <div className="onb-guide__body">
                <div className="onb-guide__t">
                  Go to <b>Credentials → Create credentials → OAuth client ID</b>. Set the{" "}
                  <b>Application type</b> to{" "}
                  <span className="onb-guide__pill">
                    <Monitor size={12} aria-hidden="true" /> Desktop app
                  </span>
                  .
                </div>
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
                <span className="onb-json-upload__title">Upload credentials JSON</span>
                <span className="onb-json-upload__sub">
                  We will extract the client ID and client secret automatically.
                </span>
              </span>
            </label>
            {jsonImportStatus ? (
              <div className="onb-json-upload__status">{jsonImportStatus}</div>
            ) : null}
            <label className="onb-cred__field">
              <span className="onb-cred__lbl">Client ID</span>
              <span className="onb-cred__in">
                <span className="ic">
                  <Fingerprint size={15} aria-hidden="true" />
                </span>
                <input
                  value={google.clientId}
                  onChange={(event) => google.setClientId(event.target.value)}
                  placeholder="000000-xxxx.apps.googleusercontent.com"
                  spellCheck={false}
                />
                {cidOk ? <Check className="onb-cred__ok" size={15} aria-hidden="true" /> : null}
              </span>
            </label>
            <label className="onb-cred__field">
              <span className="onb-cred__lbl">Client secret</span>
              <span className="onb-cred__in">
                <span className="ic">
                  <KeyRound size={15} aria-hidden="true" />
                </span>
                <input
                  type="password"
                  value={google.clientSecret}
                  onChange={(event) => google.setClientSecret(event.target.value)}
                  placeholder="GOCSPX-…"
                  spellCheck={false}
                />
                {csecOk ? <Check className="onb-cred__ok" size={15} aria-hidden="true" /> : null}
              </span>
            </label>
            <div className="onb-cred__actions">
              <Button
                size="sm"
                type="button"
                disabled={!credsReady || google.authorizationPending}
                onClick={google.openConsentScreen}
              >
                Open consent screen
              </Button>
              {google.popupBlocked && google.authUrl ? (
                <ButtonLink
                  variant="quiet"
                  size="sm"
                  href={google.authUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open manually <ExternalLink size={13} aria-hidden="true" />
                </ButtonLink>
              ) : null}
              <Button
                variant="quiet"
                size="sm"
                type="button"
                onClick={() => setMode(connected ? "connected" : "picker")}
              >
                Cancel
              </Button>
              <span className="onb-cred__hint">
                {google.popupBlocked
                  ? "Your browser blocked the popup. Use the link above to finish in a new tab."
                  : "Encrypted at rest. Stored securely and never shown in logs or briefings."}
              </span>
            </div>
          </div>
          {google.authUrl ? (
            <div className="onb-cred gflow__phase">
              <div className="onb-cred__hd">2 · Finish the connection</div>
              <p className="gflow__p">
                Once authorized, copy the full URL from your browser&apos;s address bar. It should
                begin with <code>http://localhost:1/</code>.
              </p>
              <label className="onb-cred__field">
                <span className="onb-cred__lbl">Redirect URL</span>
                <span className="onb-cred__in">
                  <span className="ic">
                    <Link2 size={15} aria-hidden="true" />
                  </span>
                  <input
                    value={google.redirectUrl}
                    onChange={(event) => google.setRedirectUrl(event.target.value)}
                    placeholder="http://localhost:1/?code=4/0Ab…&scope=…"
                    spellCheck={false}
                  />
                  {redirectReady ? (
                    <Check className="onb-cred__ok" size={15} aria-hidden="true" />
                  ) : null}
                </span>
              </label>
              <div className="onb-cred__actions">
                <Button
                  size="sm"
                  type="button"
                  disabled={!redirectReady || google.completionPending}
                  onClick={google.finishConnection}
                >
                  Finish connection
                </Button>
                <span className="onb-cred__hint">
                  Authorize first, then paste the redirect you land on.
                </span>
              </div>
            </div>
          ) : null}
          {google.error ? <p className="form-error">{google.error}</p> : null}
        </div>
      </section>
    );
  }

  if (mode === "imap") {
    return (
      <section className="onb-step" aria-labelledby="imap-connector-title">
        <StepHeader
          eyebrow={props.eyebrow}
          title={`Connect ${imapProvider.name}`}
          lede={props.lede}
        />
        <div className="onb-connector">
          <div className="onb-connector__head">
            <span className="onb-connector__g">{imapProvider.tile}</span>
            <div className="onb-connector__t">
              <div className="onb-connector__title">{imapProvider.name}</div>
              <div className="onb-connector__sub">IMAP email sync · available now</div>
            </div>
          </div>
          <div className="onb-guide__intro">
            <span className="ic">
              <ShieldCheck size={15} aria-hidden="true" />
            </span>
            <span>{imapProvider.prerequisite}</span>
          </div>
          <ol className="onb-guide">
            {imapProvider.steps.map((step, index) => {
              const isLastStep = index === imapProvider.steps.length - 1;
              return (
                <li className="onb-guide__step" key={step}>
                  <span className="onb-guide__n">{index + 1}</span>
                  <div className="onb-guide__body">
                    <div className="onb-guide__t">{step}</div>
                    {isLastStep ? (
                      <a
                        className="onb-guide__link"
                        href={imapProvider.helpUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {imapProvider.name} setup guide{" "}
                        <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
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
                  value={imapUsername}
                  onChange={(event) => setImapUsername(event.target.value)}
                  placeholder="you@example.com"
                  spellCheck={false}
                />
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
                  value={imapPassword}
                  onChange={(event) => setImapPassword(event.target.value)}
                  placeholder="Provider app password"
                  spellCheck={false}
                />
              </span>
            </label>
            <div className="onb-cred__actions">
              <Button
                variant="quiet"
                size="sm"
                type="button"
                disabled={!imapReady || testImap.isPending}
                onClick={() => testImap.mutate()}
              >
                Test connection
              </Button>
              <Button
                size="sm"
                type="button"
                disabled={!imapReady || connectImap.isPending}
                onClick={() => connectImap.mutate()}
              >
                Connect {imapProvider.name}
              </Button>
              <Button
                variant="quiet"
                size="sm"
                type="button"
                onClick={() => setMode(connected ? "connected" : "picker")}
              >
                Cancel
              </Button>
              <span className="onb-cred__hint">
                Passwords are encrypted at rest and never shown in logs or briefings.
              </span>
            </div>
            {imapTestResult ? <p className="gflow__p">{imapTestResult}</p> : null}
            {testImap.error ? <p className="form-error">{errorMessage(testImap.error)}</p> : null}
            {connectImap.error ? (
              <p className="form-error">{errorMessage(connectImap.error)}</p>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  if (mode === "connected" || (connected && mode !== "adding")) {
    const firstAccount = accounts[0];
    return (
      <section className="onb-step" aria-labelledby="google-connected-title">
        <div className="onb-eyebrow">Connected</div>
        <div className="onb-confirm">
          <span className="onb-confirm__mark">
            <Check size={22} strokeWidth={2.5} aria-hidden="true" />
          </span>
          <div className="onb-confirm__main">
            <h1 id="google-connected-title" className="onb-confirm__t">
              {accounts.length > 1
                ? `${accounts.length} accounts connected`
                : firstAccount
                  ? `${firstAccount.providerDisplayName} connected`
                  : "Provider connected"}
            </h1>
            <div className="onb-confirm__s">
              Connected data is now syncing. {assistantName} will use it to provide better context.
            </div>
          </div>
        </div>
        <div className="onb-acctlist">
          <div className="onb-acctlist__hd">
            <span className="onb-acctlist__lbl">Connected accounts</span>
            <span className="onb-acctlist__ct">
              {Math.max(accounts.length, props.done ? 1 : 0)}
            </span>
          </div>
          {accounts.length > 0 ? (
            accounts.map((account) => (
              <div className="onb-acct" key={account.id}>
                <span className="onb-acct__tile">{account.providerDisplayName.slice(0, 1)}</span>
                <div className="onb-acct__main">
                  <div className="onb-acct__email">{account.providerDisplayName}</div>
                  <div className="onb-acct__meta">
                    <span className="onb-acct__health">
                      <span className="dot" />{" "}
                      {account.status === "active" ? "Connected · syncing" : account.status}
                    </span>
                    <span className="onb-acct__sep">·</span>
                    <span className="onb-acct__scopes">
                      {account.providerType === "imap" ? "Email" : formatScopes(account.scopes)}
                    </span>
                  </div>
                </div>
                <button
                  className="onb-acct__x"
                  type="button"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(account.id)}
                >
                  Disconnect
                </button>
              </div>
            ))
          ) : (
            <div className="onb-acct">
              <span className="onb-acct__tile">G</span>
              <div className="onb-acct__main">
                <div className="onb-acct__email">Google</div>
                <div className="onb-acct__meta">
                  <span className="onb-acct__health">
                    <span className="dot" /> Connected · syncing
                  </span>
                  <span className="onb-acct__sep">·</span>
                  <span className="onb-acct__scopes">Calendar · Email</span>
                </div>
              </div>
            </div>
          )}
          <button className="onb-addmore" type="button" onClick={() => setMode("adding")}>
            <span className="onb-addmore__ic">
              <Plus size={16} aria-hidden="true" />
            </span>
            <span className="onb-addmore__main">
              <span className="onb-addmore__t">Connect another account</span>
              <span className="onb-addmore__s">Connect another account.</span>
            </span>
          </button>
        </div>
        <FootNote icon={<ShieldCheck size={15} aria-hidden="true" />}>{props.privacy}</FootNote>
      </section>
    );
  }

  return (
    <section className="onb-step" aria-labelledby="google-picker-title">
      <StepHeader eyebrow={props.eyebrow} title={props.title} lede={props.lede} />
      <div className="onb-uses">
        <div className="onb-use">
          <span className="onb-use__ic">
            <CalendarDays size={17} aria-hidden="true" />
          </span>
          <div className="onb-use__main">
            <div className="onb-use__label">Calendar</div>
            <div className="onb-use__sub">
              Read events to schedule tasks around your existing calendar.
            </div>
          </div>
        </div>
        <div className="onb-use">
          <span className="onb-use__ic">
            <Mail size={17} aria-hidden="true" />
          </span>
          <div className="onb-use__main">
            <div className="onb-use__label">Email</div>
            <div className="onb-use__sub">
              Scan emails for context and new tasks. {assistantName} will never send emails without
              your approval.
            </div>
          </div>
        </div>
      </div>
      <div className="onb-privacy">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>{props.privacy}</span>
      </div>
      <div className="onb-pickhd">
        <span className="onb-pickhd__lbl">Choose a service to connect</span>
        {mode === "adding" ? (
          <Button variant="quiet" size="sm" type="button" onClick={() => setMode("connected")}>
            Cancel
          </Button>
        ) : null}
      </div>
      <button className="onb-prov" type="button" onClick={() => setMode("connecting")}>
        <span className="onb-prov__tile">G</span>
        <span className="onb-prov__main">
          <span className="onb-prov__name">Google</span>
          <span className="onb-prov__desc">Gmail &amp; Calendar · OAuth · available now</span>
        </span>
        <span className="onb-prov__cta">
          Connect Google <ArrowRight size={15} aria-hidden="true" />
        </span>
      </button>
      {IMAP_PROVIDERS.map((provider) => (
        <button
          className="onb-prov"
          key={provider.id}
          type="button"
          onClick={() => {
            setImapProvider(provider);
            setImapTestResult(null);
            setMode("imap");
          }}
        >
          <span className="onb-prov__tile">{provider.tile}</span>
          <span className="onb-prov__main">
            <span className="onb-prov__name">{provider.name}</span>
            <span className="onb-prov__desc">Email sync · app password · available now</span>
          </span>
          <span className="onb-prov__cta">
            Connect {provider.name} <ArrowRight size={15} aria-hidden="true" />
          </span>
        </button>
      ))}
    </section>
  );
}

function formatScopes(scopes: readonly string[]): string {
  if (scopes.length === 0) return "Calendar · Email";
  const hasCalendar = scopes.some((scope) => /calendar/i.test(scope));
  const hasMail = scopes.some((scope) => /mail|gmail/i.test(scope));
  if (hasCalendar && hasMail) return "Calendar · Email";
  if (hasCalendar) return "Calendar";
  if (hasMail) return "Email";
  if (scopes.length === 1) return scopes[0] ?? "Connected";
  return `${scopes.length} scopes`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Connection failed.";
}
