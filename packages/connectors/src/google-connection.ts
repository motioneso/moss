import { randomUUID } from "node:crypto";

import type { DataContextDb } from "@moss/db";

import type { ConnectorSecretCipher, EncryptedConnectorSecret } from "./crypto.js";
import {
  GOOGLE_LOOPBACK_REDIRECT,
  GOOGLE_SCOPES,
  parseRedirectUrl,
  type GoogleConnectionSecret,
  type GoogleOAuthClient
} from "./oauth.js";
import type { ConnectorAccountSafeRow, ConnectorsRepository } from "./repository.js";

export class GoogleConnectError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "GoogleConnectError";
  }
}

export interface GoogleConnectionServiceDeps {
  readonly repository: ConnectorsRepository;
  readonly cipher: ConnectorSecretCipher;
  readonly oauthClient: GoogleOAuthClient;
  readonly generateState?: () => string;
  readonly now?: () => Date;
}

interface GooglePendingCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export class GoogleConnectionService {
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly generateState: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: GoogleConnectionServiceDeps) {
    this.generateState = deps.generateState ?? (() => randomUUID());
    this.now = deps.now ?? (() => new Date());
  }

  async startAuthorization(
    scopedDb: DataContextDb,
    input: { clientId: string; clientSecret: string }
  ): Promise<{ authUrl: string }> {
    const state = this.generateState();
    await this.deps.repository.upsertGooglePending(scopedDb, {
      state,
      encryptedSecret: this.deps.cipher.encryptJson({
        clientId: input.clientId,
        clientSecret: input.clientSecret
      })
    });
    const authUrl = this.deps.oauthClient.buildAuthUrl({
      clientId: input.clientId,
      scopes: GOOGLE_SCOPES,
      redirectUri: GOOGLE_LOOPBACK_REDIRECT,
      state
    });
    return { authUrl };
  }

  async completeAuthorization(
    scopedDb: DataContextDb,
    input: { redirectUrl: string }
  ): Promise<ConnectorAccountSafeRow> {
    const { code, state } = parseRedirectUrl(input.redirectUrl);
    const pending = await this.deps.repository.getGooglePending(scopedDb);
    if (!pending) {
      throw new GoogleConnectError(
        "No pending Google authorization found — start the connect flow again"
      );
    }
    if (pending.state !== state) {
      throw new GoogleConnectError(
        "Authorization state did not match — please retry the connect flow"
      );
    }
    const creds = decryptPendingCredentials(this.deps.cipher, pending.encryptedSecret);
    const tokens = await this.deps.oauthClient.exchangeCode({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      redirectUri: GOOGLE_LOOPBACK_REDIRECT
    });
    if (!tokens.refresh_token) {
      throw new GoogleConnectError(
        "Google did not return a refresh token — re-consent with prompt=consent"
      );
    }
    const expiry = new Date(this.now().getTime() + tokens.expires_in * 1000).toISOString();
    const bundle: GoogleConnectionSecret = {
      kind: "google-oauth",
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: expiry,
      grantedScopes: tokens.scope ? tokens.scope.split(" ") : [...GOOGLE_SCOPES]
    };
    const account = await this.deps.repository.upsertGoogleAccount(scopedDb, {
      scopes: bundle.grantedScopes,
      encryptedSecret: this.deps.cipher.encryptJson(bundle)
    });
    await this.deps.repository.deleteGooglePending(scopedDb);
    return account;
  }

  async getFreshAccessToken(
    scopedDb: DataContextDb,
    opts: { force?: boolean } = {}
  ): Promise<string> {
    const stored = await this.deps.repository.getActiveGoogleAccountSecret(scopedDb);
    if (!stored) {
      throw new GoogleConnectError("No active Google connection");
    }
    const bundle = decryptGoogleConnectionSecret(this.deps.cipher, stored.encryptedSecret);
    // More than 60 s remaining — return the cached token without a network round-trip.
    // `force` (used by the sync 401-retry path) bypasses this fast path to force a refresh.
    if (!opts.force && new Date(bundle.tokenExpiry).getTime() - this.now().getTime() > 60_000) {
      return bundle.accessToken;
    }
    const existingRefresh = this.refreshes.get(stored.id);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refresh = this.refreshAndStoreAccessToken(scopedDb, bundle);
    this.refreshes.set(stored.id, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshes.delete(stored.id);
    }
  }

  // Reads the active credential for staged provider work: the caller keeps
  // the transaction short and read-only, then refreshes outside of it.
  async readActiveCredential(
    scopedDb: DataContextDb
  ): Promise<{ accountId: string; bundle: GoogleConnectionSecret } | null> {
    const stored = await this.deps.repository.getActiveGoogleAccountSecret(scopedDb);
    if (!stored) return null;
    return {
      accountId: stored.id,
      bundle: decryptGoogleConnectionSecret(this.deps.cipher, stored.encryptedSecret)
    };
  }

  // Network-only token refresh: no database access, so staged callers run it
  // with no transaction open.
  async refreshCredential(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<{ accessToken: string; tokenExpiry: string }> {
    const refreshed = await this.deps.oauthClient.refreshAccessToken({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: input.refreshToken
    });
    return {
      accessToken: refreshed.access_token,
      tokenExpiry: new Date(this.now().getTime() + refreshed.expires_in * 1000).toISOString()
    };
  }

  // Persists a refreshed credential only when the same account is still active
  // with the same refresh token. Returns false when the account changed or
  // went away underneath the refresh instead of overwriting it.
  async storeRefreshedCredential(
    scopedDb: DataContextDb,
    expected: { accountId: string; refreshToken: string },
    next: {
      clientId: string;
      clientSecret: string;
      accessToken: string;
      tokenExpiry: string;
      grantedScopes: string[];
    }
  ): Promise<boolean> {
    const stored = await this.deps.repository.getActiveGoogleAccountSecret(scopedDb);
    if (!stored || stored.id !== expected.accountId) return false;
    const bundle = decryptGoogleConnectionSecret(this.deps.cipher, stored.encryptedSecret);
    if (bundle.refreshToken !== expected.refreshToken) return false;
    await this.deps.repository.upsertGoogleAccount(scopedDb, {
      scopes: next.grantedScopes,
      encryptedSecret: this.deps.cipher.encryptJson({
        ...bundle,
        clientId: next.clientId,
        clientSecret: next.clientSecret,
        accessToken: next.accessToken,
        tokenExpiry: next.tokenExpiry
      })
    });
    return true;
  }

  private async refreshAndStoreAccessToken(
    scopedDb: DataContextDb,
    bundle: GoogleConnectionSecret
  ): Promise<string> {
    const refreshed = await this.deps.oauthClient.refreshAccessToken({
      clientId: bundle.clientId,
      clientSecret: bundle.clientSecret,
      refreshToken: bundle.refreshToken
    });
    const nextExpiry = new Date(this.now().getTime() + refreshed.expires_in * 1000).toISOString();
    await this.deps.repository.upsertGoogleAccount(scopedDb, {
      scopes: bundle.grantedScopes,
      encryptedSecret: this.deps.cipher.encryptJson({
        ...bundle,
        accessToken: refreshed.access_token,
        tokenExpiry: nextExpiry
      })
    });
    return refreshed.access_token;
  }
}

function decryptPendingCredentials(
  cipher: ConnectorSecretCipher,
  encryptedSecret: EncryptedConnectorSecret
): GooglePendingCredentials {
  const value = cipher.decryptJson(encryptedSecret);

  if (typeof value.clientId !== "string" || typeof value.clientSecret !== "string") {
    throw new GoogleConnectError("Stored Google authorization credentials are invalid");
  }

  return {
    clientId: value.clientId,
    clientSecret: value.clientSecret
  };
}

export function decryptGoogleConnectionSecret(
  cipher: ConnectorSecretCipher,
  encryptedSecret: EncryptedConnectorSecret
): GoogleConnectionSecret {
  const value = cipher.decryptJson(encryptedSecret);

  if (
    value.kind !== "google-oauth" ||
    typeof value.clientId !== "string" ||
    typeof value.clientSecret !== "string" ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.tokenExpiry !== "string" ||
    Number.isNaN(Date.parse(value.tokenExpiry)) ||
    !isStringArray(value.grantedScopes)
  ) {
    throw new GoogleConnectError("Stored Google connection credentials are invalid");
  }

  return {
    kind: "google-oauth",
    clientId: value.clientId,
    clientSecret: value.clientSecret,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    tokenExpiry: value.tokenExpiry,
    grantedScopes: value.grantedScopes
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
