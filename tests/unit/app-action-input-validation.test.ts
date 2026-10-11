import { ApprovalInputError } from "@moss/module-sdk";
import { createAppActionValidator } from "../../packages/chat/src/app-action-validation.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActAsGrantRegistry } from "@moss/auth";
import { createRouteCatalogHolder } from "@moss/module-registry";
import { putWeatherUnitRouteSchema } from "@moss/shared";
import type { DataContextRunner } from "@moss/db";
import { createAppActionsService } from "../../packages/chat/src/app-actions.js";
import { appActionCatalog, makeAppActionGateway } from "../fixtures/app-actions-gateway.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function harness() {
  const server = Fastify();
  servers.push(server);
  const handler = vi.fn(async () => ({ unit: "metric" }));
  server.put("/api/me/weather-unit", { schema: putWeatherUnitRouteSchema }, handler);
  await server.ready();
  const holder = createRouteCatalogHolder();
  holder.set(appActionCatalog);
  const grants = createActAsGrantRegistry();
  const mint = vi.spyOn(grants, "mint");
  const appActions = createAppActionsService({
    server,
    catalog: holder,
    grants,
    readTurnId: () => null
  });
  const transport = vi.spyOn(appActions, "call");
  const { scoped } = makeRecordingDb({ rows: [] });
  const runner = {
    withDataContext: async (_access: unknown, run: (db: unknown) => unknown) => run(scoped)
  } as DataContextRunner;
  return {
    ...makeAppActionGateway({
      runner,
      appActions,
      autoApprove: false,
      provenance: { isTainted: async () => true, recordAdmission: async () => undefined }
    }),
    appActions,
    handler,
    mint,
    transport
  };
}

describe("invalid app input is validation failure, not missing presentation", () => {
  it.each([{ unit: "invalid" }, undefined, {}, { unit: "metric", hidden: "PRIVATE_EXTRA_VALUE" }])(
    "returns actionable 400 before approval or write for %j",
    async (body) => {
      const h = await harness();
      const result = await h.call({ method: "PUT", path: "/api/me/weather-unit", body });
      expect(result).toMatchObject({
        ok: true,
        structuredData: { ok: false, status: 400, body: { error: expect.any(String) } }
      });
      expect(JSON.stringify(result)).not.toContain("approval_unavailable");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_EXTRA_VALUE");
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.mint).not.toHaveBeenCalled();
      expect(h.transport).not.toHaveBeenCalled();
      expect(h.repository.createPendingAssistantAction).not.toHaveBeenCalled();
      expect(h.events).toContainEqual(
        expect.objectContaining({ kind: "action_result", outcome: "error" })
      );
      expect(h.events.some((event) => event.kind === "action_request")).toBe(false);
      expect(
        h.events.every(
          (event) => event.kind !== "action_result" || event.affectsModules === undefined
        )
      ).toBe(true);
    }
  );

  it("identifies only the first extra field without exposing its value or changing the submitted input", async () => {
    const h = await harness();
    const body = Object.freeze({
      unit: "metric",
      firstExtra: "PRIVATE_FIRST_VALUE",
      secondExtra: "PRIVATE_SECOND_VALUE"
    });
    const original = structuredClone(body);
    const result = await h.call({ method: "PUT", path: "/api/me/weather-unit", body });
    expect(result).toMatchObject({
      ok: true,
      structuredData: {
        ok: false,
        status: 400,
        body: { error: "Invalid body/firstExtra: remove fields not declared for this action." }
      }
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FIRST_VALUE");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SECOND_VALUE");
    expect(JSON.stringify(result)).not.toContain("secondExtra");
    expect(body).toEqual(original);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.repository.createPendingAssistantAction).not.toHaveBeenCalled();
    expect(h.events.some((event) => event.kind === "action_request")).toBe(false);
  });
});

it("valid fields retain complete disclosure and never receive a validation-only execution grant", async () => {
  const h = await harness();
  const input = { method: "PUT" as const, path: "/api/me/weather-unit", body: { unit: "metric" } };
  const pending = h.call(input);
  await vi.waitFor(() =>
    expect(h.events.some((event) => event.kind === "action_request")).toBe(true)
  );
  const card = h.events.find((event) => event.kind === "action_request")!;
  expect(card.details).toMatchObject({
    presentation: "human",
    target: "Weather",
    fields: [
      { label: "Temperature", value: "Celsius" },
      { label: "Wind speed", value: "Kilometres per hour" },
      { label: "Rainfall", value: "Millimetres" }
    ]
  });
  expect(input.body).toEqual({ unit: "metric" });
  expect(h.handler).not.toHaveBeenCalled();
  expect(h.mint).not.toHaveBeenCalled();
  h.confirmations.resolve(card.actionRequestId, "rejected");
  expect(await pending).toMatchObject({ ok: false, denied: true });
});

describe("schema preflight preserves submitted data and route normalization contracts", () => {
  it("does not assume all-optional object schemas accept a missing body", async () => {
    const server = Fastify();
    servers.push(server);
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { note: { type: "string" } }
    } as const;
    server.post("/optional-fields", { schema: { body: schema } }, async () => ({}));
    await server.ready();
    const route = {
      moduleId: "example",
      method: "POST",
      path: "/optional-fields",
      policy: { access: "write", content: "user_authored" },
      inputShape: { body: schema }
    } as const;
    const validate = createAppActionValidator(server);
    expect(await validate({ method: "POST", path: route.path }, route, {})).toContain(
      "Invalid body"
    );
    expect(
      await validate(
        { method: "POST", path: route.path },
        { ...route, policy: { ...route.policy, emptyBody: "object" } },
        {}
      )
    ).toBeNull();
  });
  it("rejects nested schema-stripped values and preserves the frozen original", async () => {
    const server = Fastify();
    servers.push(server);
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        options: {
          type: "object",
          additionalProperties: false,
          properties: { count: { type: "number" } }
        }
      }
    } as const;
    server.post("/nested", { schema: { body: schema } }, async () => ({}));
    await server.ready();
    const route = {
      moduleId: "example",
      method: "POST",
      path: "/nested",
      policy: { access: "write", content: "user_authored" },
      inputShape: { body: schema }
    } as const;
    const body = Object.freeze({
      options: Object.freeze({ count: 2, extra: "PRIVATE_SUBMITTED" })
    });
    const result = await createAppActionValidator(server)(
      { method: "POST", path: route.path, body },
      route,
      {}
    );
    expect(result).toBe("Invalid body/options/extra: remove fields not declared for this action.");
    expect(result).not.toContain("PRIVATE_SUBMITTED");
    expect(body.options.extra).toBe("PRIVATE_SUBMITTED");
  });
  it("validates query coercion on a clone without altering the bound string input", async () => {
    const server = Fastify();
    servers.push(server);
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["lat"],
      properties: { lat: { type: "number", minimum: -90, maximum: 90 } }
    } as const;
    server.get("/coordinates", { schema: { querystring: schema } }, async () => ({}));
    await server.ready();
    const route = {
      moduleId: "example",
      method: "GET",
      path: "/coordinates",
      policy: { access: "read", content: "user_authored" },
      inputShape: { querystring: schema }
    } as const;
    const query = Object.freeze({ lat: "48.8" });
    const validate = createAppActionValidator(server);
    expect(await validate({ method: "GET", path: route.path, query }, route, {})).toBeNull();
    expect(query).toEqual({ lat: "48.8" });
    const extraQuery = Object.freeze({ lat: "48.8", extra: "PRIVATE_QUERY_VALUE" });
    expect(await validate({ method: "GET", path: route.path, query: extraQuery }, route, {})).toBe(
      "Invalid query/extra: remove fields not declared for this action."
    );
    expect(extraQuery).toEqual({ lat: "48.8", extra: "PRIVATE_QUERY_VALUE" });
    expect(
      await validate({ method: "GET", path: route.path, query: { lat: "91" } }, route, {})
    ).toContain("Invalid query/lat");
  });
});

describe("stripped field corrections expose only safe bounded identifiers", () => {
  const itemSchema = {
    type: "object",
    additionalProperties: false,
    properties: { label: { type: "string" } }
  } as const;
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      items: { type: "array", items: itemSchema },
      options: itemSchema,
      "unsafe\nparent": itemSchema,
      ["p".repeat(48)]: {
        type: "object",
        properties: { ["q".repeat(48)]: itemSchema }
      }
    }
  } as const;
  const genericCorrection = "Invalid body: remove fields not declared for this action.";

  it.each([
    {
      name: "array index and nested extra field",
      body: {
        items: [{ label: "PRIVATE_KEPT" }, { label: "PRIVATE_KEPT", extra: "PRIVATE_VALUE" }]
      },
      correction: "Invalid body/items/1/extra: remove fields not declared for this action."
    },
    {
      name: "ordinary underscore identifier",
      body: { options: { extra_field: "PRIVATE_VALUE", "other-field": "PRIVATE_VALUE" } },
      correction: "Invalid body/options/extra_field: remove fields not declared for this action."
    },
    {
      name: "ordinary dash identifier",
      body: { options: { "extra-field": "PRIVATE_VALUE" } },
      correction: "Invalid body/options/extra-field: remove fields not declared for this action."
    },
    {
      name: "maximum segment length",
      body: { options: { ["x".repeat(48)]: "PRIVATE_VALUE" } },
      correction: `Invalid body/options/${"x".repeat(48)}: remove fields not declared for this action.`
    },
    {
      name: "maximum total path length",
      body: { ["p".repeat(48)]: { ["q".repeat(48)]: { ["r".repeat(29)]: "PRIVATE_VALUE" } } },
      correction: `Invalid body/${"p".repeat(48)}/${"q".repeat(48)}/${"r".repeat(29)}: remove fields not declared for this action.`
    },
    ...[
      "unsafe\nkey",
      "unsafe\u0000key",
      "unsafe\u202ekey",
      "private/key",
      "<script>",
      "private key",
      "x".repeat(49),
      "__proto__",
      "constructor",
      "prototype"
    ].map((key) => ({
      name: `unsafe field ${JSON.stringify(key)}`,
      body: { options: { [key]: "PRIVATE_VALUE", safeLater: "PRIVATE_LATER_VALUE" } },
      correction: genericCorrection
    })),
    {
      name: "unsafe ancestor",
      body: { "unsafe\nparent": { extra: "PRIVATE_VALUE" } },
      correction: genericCorrection
    },
    {
      name: "bounded total path length",
      body: { ["p".repeat(48)]: { ["q".repeat(48)]: { ["r".repeat(30)]: "PRIVATE_VALUE" } } },
      correction: genericCorrection
    }
  ])("$name", async ({ body, correction }) => {
    const server = Fastify();
    servers.push(server);
    const handler = vi.fn(async () => ({}));
    server.post("/field-identifiers", { schema: { body: schema } }, handler);
    await server.ready();
    const route = {
      moduleId: "example",
      method: "POST",
      path: "/field-identifiers",
      policy: { access: "write", content: "user_authored" },
      inputShape: { body: schema }
    } as const;
    const original = structuredClone(body);
    const result = await createAppActionValidator(server)(
      { method: "POST", path: route.path, body },
      route,
      {}
    );
    expect(result).toBe(correction);
    expect(result).not.toContain("PRIVATE_");
    expect(body).toEqual(original);
    expect(handler).not.toHaveBeenCalled();
  });
});

it("returns typed state validation from a route presentation without pending approval or transport", async () => {
  const h = await harness();
  const original = appActionCatalog.resolve("PUT", "/api/me/weather-unit")!;
  const route = {
    ...original.route,
    policy: {
      ...original.route.policy,
      presentation: async () => {
        throw new ApprovalInputError("Keep placed calendar blocks in the draft before saving.");
      }
    }
  };
  vi.spyOn(h.appActions, "catalog").mockReturnValue({
    routes: [route],
    resolve: () => ({ route, params: {} }),
    search: () => []
  });
  const result = await h.call({
    method: "PUT",
    path: "/api/me/weather-unit",
    body: { unit: "metric" }
  });
  expect(result).toMatchObject({
    ok: true,
    structuredData: {
      ok: false,
      status: 400,
      body: {
        code: "invalid_input",
        error: "Keep placed calendar blocks in the draft before saving."
      }
    }
  });
  expect(h.handler).not.toHaveBeenCalled();
  expect(h.transport).not.toHaveBeenCalled();
  expect(h.mint).not.toHaveBeenCalled();
  expect(h.repository.createPendingAssistantAction).not.toHaveBeenCalled();
});
