import { describe, it, expect, vi } from "vitest";
import { registerActionPolicyRoutes } from "../../packages/ai/src/action-policy-routes.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AiRoutesDependencies } from "../../packages/ai/src/routes.js";
import type { AiRepository } from "../../packages/ai/src/repository.js";
import type { DataContextRunner, DataContextDb } from "@moss/db";

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type AnyFn = Function;

describe("action policy routes", () => {
  it("rejects PATCH if module is not active", async () => {
    let handler: unknown;
    const mockServer = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn((_path, _opts, h) => {
        handler = h;
      })
    };

    const mockDeps = {
      resolveAccessContext: async () => ({ actorUserId: "user1" }),
      resolveActiveModules: async () => [],
      dataContext: {
        withDataContext: async (_ctx: unknown, fn: (db: DataContextDb) => unknown) =>
          fn({} as DataContextDb)
      } as unknown as DataContextRunner
    } as unknown as AiRoutesDependencies;

    registerActionPolicyRoutes(
      mockServer as unknown as FastifyInstance,
      mockDeps,
      {} as AiRepository
    );

    const request = {
      params: { moduleId: "test_module", actionFamilyId: "test_family" },
      body: { tier: "trusted_auto" }
    } as unknown as FastifyRequest;
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn()
    } as unknown as FastifyReply;

    await (handler as AnyFn)(request, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it("rejects PATCH if family does not exist in module", async () => {
    let handler: unknown;
    const mockServer = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn((_path, _opts, h) => {
        handler = h;
      })
    };

    const mockDeps = {
      resolveAccessContext: async () => ({ actorUserId: "user1" }),
      resolveActiveModules: async () => [
        {
          id: "test_module",
          assistantActionFamilies: []
        }
      ],
      dataContext: {
        withDataContext: async (_ctx: unknown, fn: (db: DataContextDb) => unknown) =>
          fn({} as DataContextDb)
      } as unknown as DataContextRunner
    } as unknown as AiRoutesDependencies;

    registerActionPolicyRoutes(
      mockServer as unknown as FastifyInstance,
      mockDeps,
      {} as AiRepository
    );

    const request = {
      params: { moduleId: "test_module", actionFamilyId: "test_family" },
      body: { tier: "trusted_auto" }
    } as unknown as FastifyRequest;
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn()
    } as unknown as FastifyReply;

    await (handler as AnyFn)(request, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it("rejects PATCH if tier is not allowed by family", async () => {
    let handler: unknown;
    const mockServer = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn((_path, _opts, h) => {
        handler = h;
      })
    };

    const mockDeps = {
      resolveAccessContext: async () => ({ actorUserId: "user1" }),
      resolveActiveModules: async () => [
        {
          id: "test_module",
          assistantActionFamilies: [
            {
              id: "test_family",
              allowedTiers: ["ask_each_time"]
            }
          ]
        }
      ],
      dataContext: {
        withDataContext: async (_ctx: unknown, fn: (db: DataContextDb) => unknown) =>
          fn({} as DataContextDb)
      } as unknown as DataContextRunner
    } as unknown as AiRoutesDependencies;

    registerActionPolicyRoutes(
      mockServer as unknown as FastifyInstance,
      mockDeps,
      {} as AiRepository
    );

    const request = {
      params: { moduleId: "test_module", actionFamilyId: "test_family" },
      body: { tier: "trusted_auto" }
    } as unknown as FastifyRequest;
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn()
    } as unknown as FastifyReply;

    await (handler as AnyFn)(request, reply);
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  describe("freedom presets", () => {
    function setup(families: unknown[], active = true) {
      let handler: unknown;
      const mockServer = {
        get: vi.fn(),
        patch: vi.fn(),
        post: vi.fn((_path, _opts, h) => {
          handler = h;
        })
      };
      const setActionPolicy = vi.fn(async () => undefined);
      const mockDeps = {
        resolveAccessContext: async () => ({ actorUserId: "user1" }),
        resolveActiveModules: async () =>
          active ? [{ id: "fin", assistantActionFamilies: families }] : [],
        dataContext: {
          withDataContext: async (_ctx: unknown, fn: (db: DataContextDb) => unknown) =>
            fn({} as DataContextDb)
        } as unknown as DataContextRunner
      } as unknown as AiRoutesDependencies;
      registerActionPolicyRoutes(mockServer as unknown as FastifyInstance, mockDeps, {
        setActionPolicy
      } as unknown as AiRepository);
      const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as FastifyReply;
      return {
        mockServer,
        setActionPolicy,
        reply,
        call: (step: number, moduleId = "fin") =>
          (handler as AnyFn)(
            { params: { moduleId }, body: { step } } as unknown as FastifyRequest,
            reply
          )
      };
    }

    const both = ["ask_each_time", "trusted_auto"];
    const families = [
      { id: "sorting", freedom: "routine", allowedTiers: both },
      { id: "sorting_new", freedom: "new", allowedTiers: both },
      { id: "sharing", allowedTiers: ["always_confirm"] }
    ];

    it("registers the route at the freedom path", () => {
      const { mockServer } = setup(families);
      expect(mockServer.post.mock.calls[0]?.[0]).toBe("/api/ai/action-policy/:moduleId/freedom");
    });

    it("step 2 sets routine to auto and new to ask, leaving untagged families alone", async () => {
      const { call, setActionPolicy, reply } = setup(families);
      await call(2);
      expect(setActionPolicy.mock.calls.map((c: unknown[]) => c.slice(1))).toEqual([
        ["fin", "sorting", "trusted_auto"],
        ["fin", "sorting_new", "ask_each_time"]
      ]);
      expect(reply.code).toHaveBeenCalledWith(200);
    });

    it("step 1 asks about everything and step 3 runs everything", async () => {
      const one = setup(families);
      await one.call(1);
      expect(one.setActionPolicy.mock.calls.map((c: unknown[]) => c[3])).toEqual([
        "ask_each_time",
        "ask_each_time"
      ]);
      const three = setup(families);
      await three.call(3);
      expect(three.setActionPolicy.mock.calls.map((c: unknown[]) => c[3])).toEqual([
        "trusted_auto",
        "trusted_auto"
      ]);
    });

    it("writes nothing when one tagged family disallows the preset tier", async () => {
      const { call, setActionPolicy, reply } = setup([
        { id: "sorting", freedom: "routine", allowedTiers: both },
        { id: "locked", freedom: "routine", allowedTiers: ["ask_each_time"] }
      ]);
      await call(2);
      expect(reply.code).toHaveBeenCalledWith(400);
      expect(setActionPolicy).not.toHaveBeenCalled();
    });

    it("404s for an inactive module or one with no tagged families", async () => {
      const inactive = setup(families, false);
      await inactive.call(2);
      expect(inactive.reply.code).toHaveBeenCalledWith(404);
      const untagged = setup([{ id: "sharing", allowedTiers: ["always_confirm"] }]);
      await untagged.call(2);
      expect(untagged.reply.code).toHaveBeenCalledWith(404);
      expect(untagged.setActionPolicy).not.toHaveBeenCalled();
    });
  });
});
