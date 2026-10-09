// external-modules/finance/src/adapters/plaid.ts
//
// FIN-01 (#1146) Task 4: the Plaid REST client over the FinanceFetch port.
// D1 transport hygiene is the design center: every call is a POST whose JSON
// body carries client_id/secret/access_token as BODY FIELDS (officially
// supported by Plaid), base64-encoded via bodyBase64 — the FIN-00 transport
// secret guard rejects any child→host RPC with a plaintext credential
// substring in url/headers. Headers carry content-type only.
import type { FinanceFetch, FinanceFetchRequest, PlaidEnv } from "./types.js";
import { FinanceFetchError } from "./types.js";

export type { PlaidEnv } from "./types.js";

export type PlaidCreds = { clientId: string; secret: string };

/**
 * message = Plaid error CODE only, NEVER the response body — error_message
 * is provider prose that could echo institution details into logs/results.
 */
/**
 * Plaid's own diagnostic fields for a failed call. Plaid error bodies carry
 * no credentials; only these three fields are ever kept, length-capped.
 */
export type PlaidErrorDetail = {
  type: string | null;
  message: string | null;
  requestId: string | null;
};

export class PlaidError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly detail: PlaidErrorDetail = { type: null, message: null, requestId: null }
  ) {
    super(code);
    this.name = "PlaidError";
  }
}

/** Plaid account payload mapped once at this edge: dollars → integer cents. */
export type PlaidAccount = {
  accountId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balanceCents: number;
  isoCurrency: string;
};

/**
 * Raw Plaid transaction shape (snake_case, float dollars) — deliberately NOT
 * converted here: the reducer edge (Task 6 toRecord) owns the one and only
 * dollars→cents conversion so idempotent re-application stays byte-stable.
 */
export type PlaidTx = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  iso_currency_code: string | null;
  name: string;
  merchant_name: string | null;
  personal_finance_category: { primary: string } | null;
  pending: boolean;
  pending_transaction_id: string | null;
};

export interface PlaidClient {
  linkTokenCreate(input: {
    clientUserId: string;
    daysRequested: number;
    accessToken?: string;
  }): Promise<{ linkToken: string; hostedLinkUrl: string }>;
  linkTokenGet(
    linkToken: string
  ): Promise<{ status: "pending" | "success" | "expired"; publicTokens: string[] }>;
  itemPublicTokenExchange(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  accountsGet(
    accessToken: string
  ): Promise<{ institutionId: string | null; accounts: PlaidAccount[] }>;
  /** Public institution lookup: the bank's display name, or null when Plaid has none. */
  institutionGet(institutionId: string): Promise<{ name: string | null }>;
  accountsBalanceGet(accessToken: string): Promise<{ accounts: PlaidAccount[] }>;
  transactionsSync(
    accessToken: string,
    cursor: string | null
  ): Promise<{
    added: PlaidTx[];
    modified: PlaidTx[];
    removed: { transaction_id: string }[];
    nextCursor: string;
    hasMore: boolean;
  }>;
}

type Json = Record<string, unknown>;

function mapAccount(raw: Json): PlaidAccount {
  const balances = (raw.balances ?? {}) as Json;
  return {
    accountId: String(raw.account_id),
    name: String(raw.name),
    officialName: (raw.official_name as string | null) ?? null,
    type: String(raw.type),
    subtype: (raw.subtype as string | null) ?? null,
    mask: (raw.mask as string | null) ?? null,
    // Dollars → cents once, at this edge (accounts have no reducer).
    balanceCents: Math.round(Number(balances.current ?? 0) * 100),
    isoCurrency: (balances.iso_currency_code as string | null) ?? "USD"
  };
}

const MAX_DETAIL_CHARS = 500;

/** Plaid error codes are upper snake case; anything else is not trusted as one. */
function safeCode(value: unknown, status: number): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : `http_${status}`;
}

/**
 * Plaid text saved or logged for diagnosis. Anything that looks like a token,
 * a long digit run (account numbers) or one of our own credentials is
 * replaced, then the text is capped with an explicit truncation marker.
 */
function scrubbed(value: unknown, secrets: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  let text = value;
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/\b(?:access|public|link|processor)-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/\d[\d -]{4,}\d/g, "[redacted]");
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}...[truncated]` : text;
}

export function createPlaid(
  fetchPort: FinanceFetch,
  env: PlaidEnv,
  creds: PlaidCreds
): PlaidClient {
  const secrets = [creds.clientId, creds.secret];

  function request(path: string, body: Json): FinanceFetchRequest {
    const payload = { client_id: creds.clientId, secret: creds.secret, ...body };
    return {
      url: `https://${env}.plaid.com${path}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
    };
  }

  async function call(path: string, body: Json): Promise<Json> {
    const response = await fetchPort(request(path, body));
    let json: Json;
    try {
      json = JSON.parse(response.bodyText) as Json;
    } catch {
      // Response body may be arbitrary provider content — name the failure only.
      throw new FinanceFetchError("malformed_payload", "response was not JSON");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PlaidError(safeCode(json.error_code, response.status), response.status, {
        type: scrubbed(json.error_type, secrets),
        message: scrubbed(json.error_message, secrets),
        requestId: scrubbed(json.request_id, secrets)
      });
    }
    return json;
  }

  return {
    async linkTokenCreate(input) {
      const body: Json = {
        user: { client_user_id: input.clientUserId },
        client_name: "Moss",
        language: "en",
        country_codes: ["US"],
        transactions: { days_requested: input.daysRequested },
        hosted_link: {}
      };
      if (input.accessToken !== undefined) {
        // Update-mode reauth: pass the existing item's token and do NOT
        // re-request products (Plaid rejects products in update mode).
        body.access_token = input.accessToken;
      } else {
        body.products = ["transactions"];
      }
      const json = await call("/link/token/create", body);
      return {
        linkToken: String(json.link_token),
        hostedLinkUrl: String(json.hosted_link_url)
      };
    },

    async linkTokenGet(linkToken) {
      const json = await call("/link/token/get", { link_token: linkToken });
      const sessions = Array.isArray(json.link_sessions) ? (json.link_sessions as Json[]) : [];
      const publicTokens = sessions.flatMap((session) => {
        const results = (session.results ?? {}) as Json;
        const adds = Array.isArray(results.item_add_results)
          ? (results.item_add_results as Json[])
          : [];
        return adds
          .map((add) => add.public_token)
          .filter((token): token is string => typeof token === "string");
      });
      // Success = at least one completed item add. "expired" comes from a
      // session Plaid marked EXPIRED; otherwise the session is still pending
      // (30-min abandonment is the poll handler's job via createdAt, D2).
      const status =
        publicTokens.length > 0
          ? "success"
          : sessions.some((session) => session.status === "EXPIRED")
            ? "expired"
            : "pending";
      return { status, publicTokens };
    },

    async itemPublicTokenExchange(publicToken) {
      const json = await call("/item/public_token/exchange", { public_token: publicToken });
      return { accessToken: String(json.access_token), itemId: String(json.item_id) };
    },

    async accountsGet(accessToken) {
      const json = await call("/accounts/get", { access_token: accessToken });
      const item = (json.item ?? {}) as Json;
      return {
        institutionId: (item.institution_id as string | null) ?? null,
        accounts: (Array.isArray(json.accounts) ? (json.accounts as Json[]) : []).map(mapAccount)
      };
    },

    async institutionGet(institutionId) {
      const json = await call("/institutions/get_by_id", {
        institution_id: institutionId,
        country_codes: ["US"]
      });
      const institution = (json.institution ?? {}) as Json;
      const name = typeof institution.name === "string" ? institution.name.trim() : "";
      return { name: name === "" ? null : name };
    },

    async accountsBalanceGet(accessToken) {
      const json = await call("/accounts/balance/get", { access_token: accessToken });
      return {
        accounts: (Array.isArray(json.accounts) ? (json.accounts as Json[]) : []).map(mapAccount)
      };
    },

    async transactionsSync(accessToken, cursor) {
      const body: Json = { access_token: accessToken, count: 100 };
      if (cursor !== null) body.cursor = cursor;
      const json = await call("/transactions/sync", body);
      return {
        added: (json.added ?? []) as PlaidTx[],
        modified: (json.modified ?? []) as PlaidTx[],
        removed: (json.removed ?? []) as { transaction_id: string }[],
        nextCursor: String(json.next_cursor),
        hasMore: Boolean(json.has_more)
      };
    }
  };
}
