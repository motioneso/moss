import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { HttpError, handleRouteError } from "@moss/module-sdk";

// #2681 - an account waiting for approval (or deactivated) used to get a 500 from every module
// route, because the shared handler only knew HttpError and the session-expired message.

const respondTo = async (thrown: unknown, options?: Parameters<typeof handleRouteError>[2]) => {
  const server = Fastify({ logger: false });
  server.get("/probe", async (_request, reply) => {
    try {
      throw thrown;
    } catch (error) {
      return handleRouteError(error, reply, options);
    }
  });
  const response = await server.inject({ method: "GET", url: "/probe" });
  await server.close();
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
};

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("shared route error handler", () => {
  it("answers 403 for an account pending approval, with only the fixed message and code", async () => {
    const result = await respondTo(
      coded("Account is pending approval: internal detail user=abc", "account_pending_approval")
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: "Account is pending approval",
      code: "account_pending_approval"
    });
  });

  it("answers 403 for a deactivated account, with only the fixed message and code", async () => {
    const result = await respondTo(
      coded("Account has been deactivated: internal detail user=abc", "account_deactivated")
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: "Account has been deactivated",
      code: "account_deactivated"
    });
  });

  it("keeps the same status for every other error", async () => {
    expect(await respondTo(new HttpError(404, "Not here"))).toEqual({
      status: 404,
      body: { error: "Not here" }
    });
    expect(await respondTo(new Error("Session is missing or expired"))).toEqual({
      status: 401,
      body: { error: "Session is missing or expired" }
    });
    expect(
      await respondTo(new Error("violates row-level security policy"), {
        invalidRequestMessage: "bad"
      })
    ).toEqual({ status: 400, body: { error: "bad" } });
    expect(await respondTo(new Error("boom secret detail"))).toEqual({
      status: 500,
      body: { error: "Internal server error" }
    });
    expect(await respondTo(coded("other", "some_other_code"))).toEqual({
      status: 500,
      body: { error: "Internal server error" }
    });
  });
});
