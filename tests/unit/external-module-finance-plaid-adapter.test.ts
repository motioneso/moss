// tests/unit/external-module-finance-plaid-adapter.test.ts
import { describe, expect, it } from "vitest";

import type {
  FinanceFetch,
  FinanceFetchRequest
} from "../../external-modules/finance/src/adapters/types.js";
import { createPlaid, PlaidError } from "../../external-modules/finance/src/adapters/plaid.js";

// FIN-01 (#1146) Task 4: the Plaid client. The non-negotiable contract here
// is D1 transport hygiene — credentials travel ONLY inside the base64 JSON
// body (the FIN-00 secret guard rejects plaintext credential substrings in
// url/headers), and PlaidError messages carry the Plaid error CODE only,
// never response bodies. Fixtures are recorded sandbox shapes, inline.
const CREDS = { clientId: "client-id-7f3a", secret: "secret-9b2c" };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const requests: FinanceFetchRequest[] = [];
  const fetch: FinanceFetch = async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("fake fetch exhausted");
    return { status: next.status, bodyText: JSON.stringify(next.body) };
  };
  return { requests, fetch };
}

function decodedBody(request: FinanceFetchRequest): Record<string, unknown> {
  return JSON.parse(Buffer.from(request.bodyBase64 ?? "", "base64").toString("utf8"));
}

const LINK_CREATE_FIXTURE = {
  status: 200,
  body: {
    link_token: "link-sandbox-11111111",
    hosted_link_url: "https://secure.plaid.com/hl/abc123",
    expiration: "2026-07-18T12:00:00Z",
    request_id: "req1"
  }
};

describe("plaid adapter transport hygiene (#1146, D1)", () => {
  it("sends POSTs with credentials only inside the decoded body, never url/headers", async () => {
    const { requests, fetch } = fakeFetch([
      LINK_CREATE_FIXTURE,
      {
        status: 200,
        body: { link_token: "link-sandbox-1", link_sessions: [], request_id: "req2" }
      },
      {
        status: 200,
        body: { access_token: "access-sandbox-2", item_id: "item-1", request_id: "req3" }
      },
      {
        status: 200,
        body: { accounts: [], item: { institution_id: "ins_1" }, request_id: "req4" }
      },
      { status: 200, body: { accounts: [], request_id: "req5" } },
      {
        status: 200,
        body: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "c1",
          has_more: false,
          request_id: "req6"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);

    await plaid.linkTokenCreate({ clientUserId: "user-1", daysRequested: 730 });
    await plaid.linkTokenGet("link-sandbox-1");
    await plaid.itemPublicTokenExchange("public-sandbox-1");
    await plaid.accountsGet("access-sandbox-2");
    await plaid.accountsBalanceGet("access-sandbox-2");
    await plaid.transactionsSync("access-sandbox-2", null);

    expect(requests).toHaveLength(6);
    for (const request of requests) {
      // Envelope (everything the transport guard scans besides the body)
      // must never contain a credential or access token substring.
      const envelope = JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers
      });
      expect(envelope).not.toContain(CREDS.clientId);
      expect(envelope).not.toContain(CREDS.secret);
      expect(envelope).not.toContain("access-sandbox-2");
      expect(request.method).toBe("POST");
      expect(request.url).toMatch(/^https:\/\/sandbox\.plaid\.com\//);
      expect(request.headers).toEqual({ "content-type": "application/json" });
      const body = decodedBody(request);
      expect(body.client_id).toBe(CREDS.clientId);
      expect(body.secret).toBe(CREDS.secret);
    }
  });

  it("targets production.plaid.com when env is production", async () => {
    const { requests, fetch } = fakeFetch([LINK_CREATE_FIXTURE]);
    const plaid = createPlaid(fetch, "production", CREDS);
    await plaid.linkTokenCreate({ clientUserId: "user-1", daysRequested: 730 });
    expect(requests[0]?.url).toBe("https://production.plaid.com/link/token/create");
  });
});

describe("plaid adapter request/response mapping (#1146)", () => {
  it("linkTokenCreate sends the hosted-link body and maps token + url", async () => {
    const { requests, fetch } = fakeFetch([LINK_CREATE_FIXTURE]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const result = await plaid.linkTokenCreate({ clientUserId: "user-1", daysRequested: 730 });
    expect(result).toEqual({
      linkToken: "link-sandbox-11111111",
      hostedLinkUrl: "https://secure.plaid.com/hl/abc123"
    });
    const body = decodedBody(requests[0]!);
    expect(body).toMatchObject({
      user: { client_user_id: "user-1" },
      client_name: "Moss",
      language: "en",
      country_codes: ["US"],
      products: ["transactions"],
      transactions: { days_requested: 730 },
      hosted_link: {}
    });
    expect(body).not.toHaveProperty("access_token");
  });

  it("linkTokenCreate passes access_token through for update-mode reauth", async () => {
    const { requests, fetch } = fakeFetch([LINK_CREATE_FIXTURE]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    await plaid.linkTokenCreate({
      clientUserId: "user-1",
      daysRequested: 730,
      accessToken: "access-sandbox-2"
    });
    const body = decodedBody(requests[0]!);
    expect(body.access_token).toBe("access-sandbox-2");
    // Update mode must not re-request products (Plaid rejects it).
    expect(body).not.toHaveProperty("products");
  });

  it("linkTokenGet extracts public tokens and success status", async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: {
          link_token: "link-sandbox-1",
          link_sessions: [
            {
              link_session_id: "ls-1",
              results: {
                item_add_results: [
                  { public_token: "public-sandbox-aa" },
                  { public_token: "public-sandbox-bb" }
                ]
              }
            }
          ],
          request_id: "req2"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const result = await plaid.linkTokenGet("link-sandbox-1");
    expect(result).toEqual({
      status: "success",
      publicTokens: ["public-sandbox-aa", "public-sandbox-bb"]
    });
  });

  it("linkTokenGet reports pending when no session has completed", async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: { link_token: "link-sandbox-1", link_sessions: [], request_id: "req2" }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const result = await plaid.linkTokenGet("link-sandbox-1");
    expect(result).toEqual({ status: "pending", publicTokens: [] });
  });

  it("itemPublicTokenExchange maps access token + item id", async () => {
    const { requests, fetch } = fakeFetch([
      {
        status: 200,
        body: { access_token: "access-sandbox-2", item_id: "item-1", request_id: "req3" }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const result = await plaid.itemPublicTokenExchange("public-sandbox-aa");
    expect(result).toEqual({ accessToken: "access-sandbox-2", itemId: "item-1" });
    expect(decodedBody(requests[0]!).public_token).toBe("public-sandbox-aa");
  });

  it("accountsGet maps institution + accounts with cent balances", async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: {
          accounts: [
            {
              account_id: "acc-1",
              balances: { current: 1210.55, iso_currency_code: "USD" },
              name: "Checking",
              official_name: "Everyday Checking",
              type: "depository",
              subtype: "checking",
              mask: "0000"
            }
          ],
          item: { institution_id: "ins_1" },
          request_id: "req4"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const result = await plaid.accountsGet("access-sandbox-2");
    expect(result).toEqual({
      institutionId: "ins_1",
      accounts: [
        {
          accountId: "acc-1",
          name: "Checking",
          officialName: "Everyday Checking",
          type: "depository",
          subtype: "checking",
          mask: "0000",
          balanceCents: 121055,
          isoCurrency: "USD"
        }
      ]
    });
  });

  it("institutionGet asks the institutions endpoint by id and maps the name", async () => {
    const { requests, fetch } = fakeFetch([
      {
        status: 200,
        body: { institution: { institution_id: "ins_1", name: " Sandbox First Bank " } }
      },
      { status: 200, body: { institution: { institution_id: "ins_2", name: "" } } }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    expect(await plaid.institutionGet("ins_1")).toEqual({ name: "Sandbox First Bank" });
    expect(requests[0]!.url).toBe("https://sandbox.plaid.com/institutions/get_by_id");
    expect(decodedBody(requests[0]!)).toMatchObject({
      institution_id: "ins_1",
      country_codes: ["US"]
    });
    expect(await plaid.institutionGet("ins_2")).toEqual({ name: null });
  });

  it("transactionsSync passes cursor + fixed count and maps pages", async () => {
    const tx = {
      transaction_id: "tx-1",
      account_id: "acc-1",
      date: "2026-07-17",
      amount: 12.34,
      iso_currency_code: "USD",
      name: "TRADER JOE'S #123",
      merchant_name: "Trader Joe's",
      personal_finance_category: { primary: "FOOD_AND_DRINK" },
      pending: false,
      pending_transaction_id: null
    };
    const { requests, fetch } = fakeFetch([
      {
        status: 200,
        body: {
          added: [tx],
          modified: [],
          removed: [{ transaction_id: "tx-0" }],
          next_cursor: "cursor-2",
          has_more: true,
          request_id: "req6"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const result = await plaid.transactionsSync("access-sandbox-2", "cursor-1");
    expect(result).toEqual({
      added: [tx],
      modified: [],
      removed: [{ transaction_id: "tx-0" }],
      nextCursor: "cursor-2",
      hasMore: true
    });
    const body = decodedBody(requests[0]!);
    expect(body).toMatchObject({
      access_token: "access-sandbox-2",
      cursor: "cursor-1",
      count: 100
    });
  });

  it("transactionsSync omits cursor on first sync (null)", async () => {
    const { requests, fetch } = fakeFetch([
      {
        status: 200,
        body: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "c1",
          has_more: false,
          request_id: "req6"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    await plaid.transactionsSync("access-sandbox-2", null);
    expect(decodedBody(requests[0]!)).not.toHaveProperty("cursor");
  });
});

describe("plaid adapter error mapping (#1146)", () => {
  it("maps a Plaid error body to PlaidError with code only — body stays out", async () => {
    const { fetch } = fakeFetch([
      {
        status: 400,
        body: {
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message: "the user must re-authenticate SECRET-DETAIL",
          request_id: "req9"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const error = await plaid.accountsGet("access-sandbox-2").then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(PlaidError);
    const plaidError = error as PlaidError;
    expect(plaidError.code).toBe("ITEM_LOGIN_REQUIRED");
    expect(plaidError.httpStatus).toBe(400);
    expect(plaidError.message).toBe("ITEM_LOGIN_REQUIRED");
    expect(plaidError.message).not.toContain("SECRET-DETAIL");
  });

  it("keeps Plaid's type, message and request id as detail for diagnosis (#3161)", async () => {
    const { fetch } = fakeFetch([
      {
        status: 400,
        body: {
          error_type: "INVALID_REQUEST",
          error_code: "INVALID_PRODUCT",
          error_message: "client is not authorized to access: balance",
          request_id: "req9",
          access_token: "must-not-be-kept"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const error = (await plaid.accountsBalanceGet("access-sandbox-2").then(
      () => null,
      (e: unknown) => e
    )) as PlaidError;
    expect(error.detail).toEqual({
      type: "INVALID_REQUEST",
      message: "client is not authorized to access: balance",
      requestId: "req9"
    });
    expect(error.message).toBe("INVALID_PRODUCT");
  });

  it("falls back to http_<status> when the error body carries no code", async () => {
    const { fetch } = fakeFetch([{ status: 502, body: { oops: true } }]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const error = await plaid.accountsBalanceGet("access-sandbox-2").then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(PlaidError);
    expect((error as PlaidError).code).toBe("http_502");
    expect((error as PlaidError).httpStatus).toBe(502);
  });
});

describe("PlaidError detail scrubbing (#3161)", () => {
  it("removes tokens, long digit runs and our own credentials from saved text", async () => {
    const { fetch } = fakeFetch([
      {
        status: 400,
        body: {
          error_code: "INVALID_REQUEST",
          error_type: "INVALID_REQUEST",
          error_message: `bad access-sandbox-abc-123 acct 123456789 key ${CREDS.secret} ${"x".repeat(600)}`,
          request_id: "req-1"
        }
      }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const error = await plaid.accountsGet("access-sandbox-tok").then(
      () => null,
      (e: unknown) => e as PlaidError
    );
    const message = error?.detail.message ?? "";
    expect(message).not.toContain("access-sandbox-abc-123");
    expect(message).not.toContain("123456789");
    expect(message).not.toContain(CREDS.secret);
    expect(message).toContain("[redacted]");
    expect(message.endsWith("...[truncated]")).toBe(true);
  });

  it("does not trust a provider error code that is not upper snake case", async () => {
    const { fetch } = fakeFetch([
      { status: 400, body: { error_code: `oops ${CREDS.secret}`, error_message: "x" } }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const error = await plaid.accountsGet("t").then(
      () => null,
      (e: unknown) => e as PlaidError
    );
    expect(error?.code).toBe("http_400");
  });

  it("removes account numbers written with separators", async () => {
    const { fetch } = fakeFetch([
      { status: 400, body: { error_code: "X_Y", error_message: "acct 1234-5678-9012 bad" } }
    ]);
    const plaid = createPlaid(fetch, "sandbox", CREDS);
    const error = await plaid.accountsGet("t").then(
      () => null,
      (e: unknown) => e as PlaidError
    );
    expect(error?.detail.message).not.toMatch(/\d{4}/);
  });
});
