import { describe, expect, it, vi } from "vitest";

import { sanitizeAssistantToolResult } from "@moss/ai";
import {
  platformDiagnosticsExecute,
  platformDiagnosticsInputSchema,
  platformDiagnosticsOutputSchema
} from "@moss/settings";

describe("settings.platformDiagnostics", () => {
  const report = {
    observedAt: "2026-08-27T10:00:00.000Z",
    build: { version: "1.2.3", buildId: "build-1" },
    runtime: null,
    modules: [],
    errors: [],
    actions: [],
    jobs: { recent: [], summaries: [], truncated: false },
    connections: { items: [], truncated: false },
    source: null,
    redactions: ["runtime"]
  };

  it("uses only the supplied read service and bounds the request", async () => {
    const observe = vi.fn().mockResolvedValue(report);
    const result = await platformDiagnosticsExecute(
      {} as never,
      {
        question: "  Is news fresh?  ",
        module: " news ",
        include: ["modules", "source"],
        limit: 99
      },
      { actorUserId: "user-1", requestId: "request-1" } as never,
      { platformDiagnostics: { observe } }
    );

    expect(result).toEqual({ data: report });
    expect(observe).toHaveBeenCalledWith(
      {},
      { actorUserId: "user-1", requestId: "request-1" },
      { query: "Is news fresh?", domain: "news", include: ["modules", "source"], limit: 10 }
    );
  });

  it("fails closed when the read service is absent", async () => {
    await expect(
      platformDiagnosticsExecute(
        {} as never,
        {},
        { actorUserId: "user-1", requestId: "request-1" } as never,
        {}
      )
    ).rejects.toThrow("platform diagnostics read service is unavailable");
  });

  it("rejects unknown input and removes undeclared report fields", async () => {
    await expect(
      platformDiagnosticsExecute(
        {} as never,
        { unexpected: true },
        { actorUserId: "user-1", requestId: "request-1" } as never,
        { platformDiagnostics: { observe: vi.fn() } }
      )
    ).rejects.toThrow("does not accept unexpected");

    const sanitized = sanitizeAssistantToolResult(platformDiagnosticsOutputSchema, {
      data: {
        ...report,
        modules: [
          {
            domain: "news",
            providerId: "news.refresh",
            observedAt: report.observedAt,
            status: "ok",
            summary: "News is current.",
            facts: { itemCount: 3, secret: "must not cross the tool boundary" }
          }
        ],
        secret: "must not cross the tool boundary"
      }
    });
    expect(sanitized.data).not.toHaveProperty("secret");
    expect(sanitized.data.modules).toEqual([expect.objectContaining({ facts: { itemCount: 3 } })]);
  });

  it("declares strict bounded input and output fields", () => {
    expect(platformDiagnosticsInputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", maxLength: 240 },
        module: { type: "string", maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: 10 }
      }
    });
    expect(platformDiagnosticsOutputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "observedAt",
        "build",
        "runtime",
        "modules",
        "errors",
        "actions",
        "jobs",
        "connections",
        "source",
        "redactions"
      ]
    });
  });

  it("accepts jobs and connections as sections and rejects an unknown one", async () => {
    const observe = vi.fn().mockResolvedValue(report);
    const ctx = { actorUserId: "user-1", requestId: "request-1" } as never;
    await platformDiagnosticsExecute({} as never, { include: ["jobs", "connections"] }, ctx, {
      platformDiagnostics: { observe }
    });
    expect(observe).toHaveBeenCalledWith({}, ctx, { include: ["jobs", "connections"] });
    expect(platformDiagnosticsInputSchema.properties.include.items.enum).toEqual(
      expect.arrayContaining(["jobs", "connections"])
    );
    await expect(
      platformDiagnosticsExecute({} as never, { include: ["logs"] }, ctx, {
        platformDiagnostics: { observe }
      })
    ).rejects.toThrow("unsupported section");
  });

  it("keeps jobs and connections in the output and strips undeclared fields inside them", () => {
    const sanitized = sanitizeAssistantToolResult(platformDiagnosticsOutputSchema, {
      data: {
        ...report,
        jobs: {
          recent: [
            {
              occurredAt: report.observedAt,
              queue: "connectors.sync",
              state: "failed",
              retryCount: 1,
              ownerKnown: true,
              kind: "sync",
              connectorAccountId: null,
              errorLabel: "failed",
              data: "must not cross the tool boundary"
            }
          ],
          summaries: [],
          truncated: false
        }
      }
    });
    expect(JSON.stringify(sanitized.data)).not.toContain("must not cross");
    expect(sanitized.data.jobs).toMatchObject({ recent: [{ queue: "connectors.sync" }] });
  });
});
