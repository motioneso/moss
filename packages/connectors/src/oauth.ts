export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_LOOPBACK_REDIRECT = "http://localhost:1";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar"
] as const;

export interface GoogleConnectionSecret extends Record<string, unknown> {
  readonly kind: "google-oauth";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenExpiry: string; // ISO
  readonly grantedScopes: string[];
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

// Minimal Logger interface — avoids adding a pino/fastify dependency to connectors.
interface OAuthLogger {
  error(data: Record<string, unknown>, message: string): void;
}

// Silent default — production ALWAYS injects a real logger at the composition
// root. Noop (not console) so a forgotten injection degrades quietly rather than
// spamming unstructured console output (observability spec: no console.* in prod).
const NOOP_OAUTH_LOGGER: OAuthLogger = {
  error: () => undefined
};

export interface GoogleOAuthClientDeps {
  readonly fetchFn?: typeof fetch;
  readonly logger?: OAuthLogger;
  readonly requestTimeoutMs?: number;
}

export const GOOGLE_OAUTH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How a failed token call has to be treated by its caller.
 *
 * - `needs-reconnect`: Google refused the saved grant (revoked, expired, or a client the
 *   project no longer has). Only a new sign-in fixes it.
 * - `transient`: Google did not answer, answered too slowly, or answered "try again later"
 *   (a 5xx or a 429). The saved sign-in is untouched and the next run should try again.
 *
 * An unrecognised refusal keeps today's behaviour and asks for a reconnect, so a real auth
 * problem never hides behind a retry loop.
 */
export type GoogleTokenFailureKind = "needs-reconnect" | "transient";

const OAUTH_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * A token-endpoint failure with the parts a caller is allowed to act on: the HTTP status, the
 * OAuth error code, and whether the fix is a reconnect or a retry.
 *
 * The message deliberately carries neither the OAuth code nor the response body. The split
 * lives in `kind`, not in text a caller would have to parse, and #141's rule still holds: no
 * provider body, token or secret in the message, which error handlers log and may echo.
 */
export class GoogleTokenError extends Error {
  readonly statusCode: number | null;
  readonly oauthError: string | null;
  readonly kind: GoogleTokenFailureKind;

  constructor(input: {
    kind: GoogleTokenFailureKind;
    statusCode: number | null;
    oauthError: string | null;
    message: string;
  }) {
    super(input.message);
    this.name = "GoogleTokenError";
    this.kind = input.kind;
    this.statusCode = input.statusCode;
    this.oauthError = input.oauthError;
  }
}

/**
 * True only when the failure says Google, not the grant, is the problem. Callers use this to
 * keep the connection, record a retry label, and leave Reconnect alone.
 */
export function isTransientGoogleTokenFailure(error: unknown): boolean {
  return error instanceof GoogleTokenError && error.kind === "transient";
}

/**
 * Only Google's own failures are temporary: no answer at all, a 5xx, or a 429. Every answer is a
 * refusal of the saved grant (400/401 carry `invalid_grant`, `invalid_client` or
 * `unauthorized_client`), and an unrecognised refusal stays a reconnect too, so a real auth
 * problem never hides behind a retry loop. The OAuth code rides along on the error for callers
 * that want it; the status alone decides retry versus reconnect.
 */
function classifyTokenFailure(statusCode: number | null): GoogleTokenFailureKind {
  if (statusCode === null) return "transient";
  if (statusCode >= 500 || statusCode === 429) return "transient";
  return "needs-reconnect";
}

/**
 * The OAuth error code from a failed token response, and nothing else. Google answers
 * `{"error":"invalid_grant","error_description":"..."}`; only a short token-shaped code is
 * kept, so prose (or a future field carrying something private) can never ride along.
 */
async function readOAuthErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null) return null;
    const code = (body as { error?: unknown }).error;
    return typeof code === "string" && OAUTH_ERROR_CODE.test(code) ? code : null;
  } catch {
    // A body that is not JSON, or has already been read, names no code. Still a failure.
    return null;
  }
}

export function parseRedirectUrl(redirectUrl: string): { code: string; state: string } {
  let url: URL;
  try {
    url = new URL(redirectUrl.trim());
  } catch {
    throw new Error("Pasted redirect URL is not a valid URL");
  }
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(`Google returned an authorization error: ${error}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new Error("Redirect URL is missing the code or state parameter");
  }
  return { code, state };
}

export class GoogleOAuthClient {
  private readonly fetchFn: typeof fetch;
  private readonly logger: OAuthLogger;
  private readonly requestTimeoutMs: number;

  constructor(deps: GoogleOAuthClientDeps = {}) {
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.logger = deps.logger ?? NOOP_OAUTH_LOGGER;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? GOOGLE_OAUTH_REQUEST_TIMEOUT_MS;
  }

  buildAuthUrl(input: {
    clientId: string;
    scopes: readonly string[];
    redirectUri: string;
    state: string;
  }): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", input.state);
    url.searchParams.set("scope", input.scopes.join(" "));
    return url.toString();
  }

  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<GoogleTokenResponse> {
    return this.postToken({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code"
    });
  }

  async refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<GoogleTokenResponse> {
    return this.postToken({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token"
    });
  }

  private async postToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
    let response: Response;
    try {
      response = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch {
      // A timeout or a network failure never reached Google, so nothing about the grant is
      // known. The underlying error is not logged (it can quote the request URL/params).
      this.logger.error({ stage: "network" }, "Google token exchange did not answer");
      throw new GoogleTokenError({
        kind: "transient",
        statusCode: null,
        oauthError: null,
        message: "Google token endpoint did not answer"
      });
    }
    if (!response.ok) {
      // Keep the OAuth error code (`invalid_grant` and friends) as a typed property so the sync
      // can tell "retry next tick" from "reconnect"; drop the rest of the body. #141: never embed
      // it in the Error message — an error handler logs that text and may echo it to the client.
      const oauthError = await readOAuthErrorCode(response);
      this.logger.error({ statusCode: response.status }, "Google token exchange failed");
      throw new GoogleTokenError({
        kind: classifyTokenFailure(response.status),
        statusCode: response.status,
        oauthError,
        message: `Google token endpoint returned ${response.status}`
      });
    }
    return (await response.json()) as GoogleTokenResponse;
  }
}
