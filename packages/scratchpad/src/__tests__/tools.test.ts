import { describe, expect, it } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";

import { scratchpadAppendExecute, scratchpadReadExecute } from "../tools.js";

// #2236 slice 1: only the input-validation branches of the tools are covered here, without a
// database. Every branch below returns before the code ever reaches `scopedDb.db`, so a fake
// scratchpadBrand marker is enough to satisfy the DataContextDb type check.
const fakeScopedDb = { [dataContextBrand]: true } as unknown as DataContextDb;
const fakeCtx = {} as ToolContext;

describe("scratchpadAppendExecute validation", () => {
  it("rejects empty text", async () => {
    const result = await scratchpadAppendExecute(fakeScopedDb, { text: "" }, fakeCtx);
    expect(result.data).toMatchObject({ error: expect.stringContaining("empty") });
  });

  it("rejects text that is only whitespace", async () => {
    const result = await scratchpadAppendExecute(fakeScopedDb, { text: "   " }, fakeCtx);
    expect(result.data).toMatchObject({ error: expect.stringContaining("empty") });
  });

  it("rejects text longer than 2000 characters", async () => {
    const longText = "a".repeat(2001);
    const result = await scratchpadAppendExecute(fakeScopedDb, { text: longText }, fakeCtx);
    expect(result.data).toMatchObject({ error: expect.stringContaining("too long") });
  });
});

describe("scratchpad tool exports", () => {
  it("both tools are functions", () => {
    expect(typeof scratchpadReadExecute).toBe("function");
    expect(typeof scratchpadAppendExecute).toBe("function");
  });
});
