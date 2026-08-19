import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { parseCalendarEventRef, resolveCalendarEventRef } from "@moss/calendar";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

describe("parseCalendarEventRef", () => {
  it("classifies a well-formed UUID as moss_id", () => {
    expect(parseCalendarEventRef("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toEqual({
      kind: "moss_id",
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    });
  });

  it("classifies a Google opaque id as external_id", () => {
    expect(parseCalendarEventRef("7c3f8b2e4d5a6b1c@google.com")).toEqual({
      kind: "external_id",
      id: "7c3f8b2e4d5a6b1c@google.com"
    });
  });

  it("classifies a jfb-prefixed compat id as external_id", () => {
    expect(parseCalendarEventRef("jfb_abc123")).toEqual({
      kind: "external_id",
      id: "jfb_abc123"
    });
  });
});

describe("resolveCalendarEventRef", () => {
  it("returns not_found (never throws) for a non-UUID string with no matching external event", async () => {
    const repository = {
      getById: async () => {
        throw new Error("should not be called for a non-UUID ref");
      },
      getByExternalId: async () => undefined
    };

    const result = await resolveCalendarEventRef(
      scopedDb,
      repository,
      "connector-account-1",
      "7c3f8b2e4d5a6b1c@google.com"
    );

    expect(result).toEqual({ found: false, reason: "not_found" });
  });

  it("returns not_found for a UUID with no matching row (RLS-scoped lookup)", async () => {
    const repository = {
      getById: async () => undefined,
      getByExternalId: async () => {
        throw new Error("should not be called for a UUID ref");
      }
    };

    const result = await resolveCalendarEventRef(
      scopedDb,
      repository,
      "connector-account-1",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );

    expect(result).toEqual({ found: false, reason: "not_found" });
  });

  it("returns invalid_input for non-string input without calling the repository", async () => {
    const repository = {
      getById: async () => {
        throw new Error("should not be called");
      },
      getByExternalId: async () => {
        throw new Error("should not be called");
      }
    };

    const result = await resolveCalendarEventRef(scopedDb, repository, "connector-account-1", 42);

    expect(result).toEqual({ found: false, reason: "invalid_input" });
  });

  it("resolves a UUID via getById", async () => {
    const event = { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", title: "Test" };
    const repository = {
      getById: async () => event as never,
      getByExternalId: async () => {
        throw new Error("should not be called for a UUID ref");
      }
    };

    const result = await resolveCalendarEventRef(
      scopedDb,
      repository,
      "connector-account-1",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );

    expect(result).toEqual({ found: true, event });
  });

  it("resolves an external id via getByExternalId scoped to the given connector account", async () => {
    const event = { id: "moss-uuid", externalId: "abc@google.com" };
    let receivedInput: unknown;
    const repository = {
      getById: async () => {
        throw new Error("should not be called for a non-UUID ref");
      },
      getByExternalId: async (
        _db: DataContextDb,
        input: { connectorAccountId: string; externalId: string }
      ) => {
        receivedInput = input;
        return event as never;
      }
    };

    const result = await resolveCalendarEventRef(
      scopedDb,
      repository,
      "connector-account-1",
      "abc@google.com"
    );

    expect(result).toEqual({ found: true, event });
    expect(receivedInput).toEqual({
      connectorAccountId: "connector-account-1",
      externalId: "abc@google.com"
    });
  });

  it("returns not_found instead of throwing when no active connector account is available", async () => {
    const repository = {
      getById: async () => {
        throw new Error("should not be called for a non-UUID ref");
      },
      getByExternalId: async () => {
        throw new Error("should not be called without a connector account");
      }
    };

    const result = await resolveCalendarEventRef(scopedDb, repository, undefined, "abc@google.com");

    expect(result).toEqual({ found: false, reason: "not_found" });
  });
});
