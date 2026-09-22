import { describe, expect, it, vi } from "vitest";

import { GoogleApiClient, GoogleApiError, isRetryableGoogleError } from "@moss/connectors";

import { withTokenRetry } from "../../packages/connectors/src/google-sync-phases.js";

/** The modern Google error body: a generic `status` plus the specific `errors[].reason`. */
function errorResponse(body: unknown, status = 403): Response {
  return {
    ok: false,
    status,
    json: async () => body
  } as Response;
}

describe("Google API error detail (#2300)", () => {
  it("names the specific reason and the operation, not the generic status", async () => {
    const fetchFn = (async () =>
      errorResponse({
        error: {
          code: 403,
          message: "User Rate Limit Exceeded",
          status: "PERMISSION_DENIED",
          errors: [
            {
              domain: "usageLimits",
              reason: "userRateLimitExceeded",
              message: "User Rate Limit Exceeded"
            }
          ]
        }
      })) as typeof fetch;
    const client = new GoogleApiClient({ fetchFn });

    await expect(client.listMessageIdsPage({ accessToken: "tok" })).rejects.toMatchObject({
      statusCode: 403,
      reason: "userRateLimitExceeded",
      operation: "gmail.messages.list"
    });
  });

  it("falls back to the ErrorInfo detail when there is no errors[] entry", async () => {
    const fetchFn = (async () =>
      errorResponse({
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }]
        }
      })) as typeof fetch;
    const client = new GoogleApiClient({ fetchFn });

    await expect(client.getMessage({ accessToken: "tok", id: "m1" })).rejects.toMatchObject({
      reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      operation: "gmail.messages.get"
    });
  });

  it("logs the operation, status and reason through the injected logger", async () => {
    const error = vi.fn();
    const fetchFn = (async () =>
      errorResponse(
        {
          error: { code: 500, status: "INTERNAL", errors: [{ reason: "backendError" }] }
        },
        500
      )) as typeof fetch;
    const client = new GoogleApiClient({ fetchFn, logger: { error } });

    await expect(
      client.listCalendarEventsPage({
        accessToken: "tok",
        timeMin: "2026-01-01T00:00:00.000Z",
        timeMax: "2026-01-02T00:00:00.000Z"
      })
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(error).toHaveBeenCalledWith(
      {
        statusCode: 500,
        api: "calendar",
        operation: "calendar.events.list",
        reason: "backendError"
      },
      "Google API call failed"
    );
  });

  it("classifies rate limits and 5xx as retryable but a permission refusal as not", () => {
    expect(isRetryableGoogleError(new GoogleApiError("x", 403, "userRateLimitExceeded"))).toBe(
      true
    );
    expect(isRetryableGoogleError(new GoogleApiError("x", 429))).toBe(true);
    expect(isRetryableGoogleError(new GoogleApiError("x", 503))).toBe(true);
    expect(isRetryableGoogleError(new GoogleApiError("x", 403, "PERMISSION_DENIED"))).toBe(false);
    expect(isRetryableGoogleError(new GoogleApiError("x", 403, "domainPolicy"))).toBe(false);
    expect(isRetryableGoogleError(new Error("not google"))).toBe(false);
  });
});

describe("Google read retry (#2300)", () => {
  const deps = (): never => ({ googleRetryDelayMs: 0 }) as never;

  it("retries a rate-limited read and returns the later success", async () => {
    const rateLimited = new GoogleApiError(
      "Google gmail returned 403",
      403,
      "userRateLimitExceeded",
      "gmail.messages.list"
    );
    let calls = 0;
    const result = await withTokenRetry({} as never, deps(), { token: "tok" }, async () => {
      calls += 1;
      if (calls < 3) throw rateLimited;
      return "page";
    });
    expect(result).toBe("page");
    expect(calls).toBe(3);
  });

  it("gives up after the bounded attempts and rethrows the last rate-limit error", async () => {
    const rateLimited = new GoogleApiError("Google gmail returned 403", 403, "rateLimitExceeded");
    let calls = 0;
    await expect(
      withTokenRetry({} as never, deps(), { token: "tok" }, async () => {
        calls += 1;
        throw rateLimited;
      })
    ).rejects.toBe(rateLimited);
    expect(calls).toBe(3);
  });

  it("does NOT retry a permission refusal", async () => {
    const refused = new GoogleApiError(
      "Google gmail returned 403",
      403,
      "PERMISSION_DENIED",
      "gmail.messages.list"
    );
    let calls = 0;
    await expect(
      withTokenRetry({} as never, deps(), { token: "tok" }, async () => {
        calls += 1;
        throw refused;
      })
    ).rejects.toBe(refused);
    expect(calls).toBe(1);
  });
});
