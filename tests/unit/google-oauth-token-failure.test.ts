import { describe, expect, it } from "vitest";

import {
  GoogleOAuthClient,
  GoogleTokenError,
  isTransientGoogleTokenFailure
} from "@moss/connectors";

const REFRESH = { clientId: "cid", clientSecret: "sec", refreshToken: "rt" };

function endpointSays(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })) as unknown as typeof fetch;
}

function networkFails(reason: unknown): typeof fetch {
  return (async () => {
    throw reason;
  }) as unknown as typeof fetch;
}

async function refreshFailure(fetchFn: typeof fetch): Promise<GoogleTokenError> {
  const client = new GoogleOAuthClient({ fetchFn, logger: { error: () => undefined } });
  const thrown = await client.refreshAccessToken(REFRESH).then(
    () => null,
    (error: unknown) => error
  );
  expect(thrown).toBeInstanceOf(GoogleTokenError);
  return thrown as GoogleTokenError;
}

describe("Google token refresh failure classification", () => {
  it("treats a 503 as temporary, so the connection is kept and the next run retries", async () => {
    const error = await refreshFailure(endpointSays(503, { error: "backend_error" }));
    expect(error.kind).toBe("transient");
    expect(error.statusCode).toBe(503);
    expect(isTransientGoogleTokenFailure(error)).toBe(true);
  });

  it("treats a 429 as temporary", async () => {
    const error = await refreshFailure(endpointSays(429, { error: "rate_limit_exceeded" }));
    expect(error.kind).toBe("transient");
    expect(isTransientGoogleTokenFailure(error)).toBe(true);
  });

  it("treats a request the endpoint never answered as temporary", async () => {
    const error = await refreshFailure(networkFails(new TypeError("fetch failed")));
    expect(error.kind).toBe("transient");
    expect(error.statusCode).toBeNull();
    expect(isTransientGoogleTokenFailure(error)).toBe(true);
    expect(error.message).not.toContain("fetch failed");
  });

  it("treats a timed-out request as temporary", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const error = await refreshFailure(networkFails(timeout));
    expect(error.kind).toBe("transient");
    expect(isTransientGoogleTokenFailure(error)).toBe(true);
  });

  it("treats a 400 invalid_grant as a grant that needs reconnecting", async () => {
    const error = await refreshFailure(
      endpointSays(400, { error: "invalid_grant", error_description: "Bad Request" })
    );
    expect(error.kind).toBe("needs-reconnect");
    expect(error.statusCode).toBe(400);
    expect(error.oauthError).toBe("invalid_grant");
    expect(isTransientGoogleTokenFailure(error)).toBe(false);
  });

  it("treats a 401 invalid_client as a grant that needs reconnecting", async () => {
    const error = await refreshFailure(
      endpointSays(401, { error: "invalid_client", error_description: "Unauthorized" })
    );
    expect(error.kind).toBe("needs-reconnect");
    expect(error.oauthError).toBe("invalid_client");
    expect(isTransientGoogleTokenFailure(error)).toBe(false);
  });

  it("treats an unrecognised refusal as needing a reconnect, as it does today", async () => {
    const error = await refreshFailure(endpointSays(403, {}));
    expect(error.kind).toBe("needs-reconnect");
    expect(error.oauthError).toBeNull();
  });

  it("carries the OAuth error code without putting it or the body in the message", async () => {
    const error = await refreshFailure(
      endpointSays(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked for secret-token"
      })
    );
    expect(error.message).toBe("Google token endpoint returned 400");
    expect(error.message).not.toContain("invalid_grant");
    expect(error.message).not.toContain("secret-token");
  });

  it("keeps only a token-shaped OAuth error code, never prose from the body", async () => {
    const error = await refreshFailure(
      endpointSays(400, {
        error: "invalid_grant <html>secret-token</html>",
        error_description: "secret-token"
      })
    );
    expect(error.oauthError).toBeNull();
    expect(error.message).not.toContain("secret-token");
  });

  it("logs the status only, never the response body", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const client = new GoogleOAuthClient({
      fetchFn: endpointSays(503, { error: "backend_error", error_description: "secret-token" }),
      logger: {
        error: (data) => {
          logged.push(data);
        }
      }
    });
    await client.refreshAccessToken(REFRESH).catch(() => undefined);
    expect(logged).toEqual([{ statusCode: 503 }]);
    expect(JSON.stringify(logged)).not.toContain("secret-token");
    expect(JSON.stringify(logged)).not.toContain("backend_error");
  });
});
