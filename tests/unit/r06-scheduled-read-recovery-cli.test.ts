import { describe, expect, it } from "vitest";
import { parseRecoveryInvocation } from "../../scripts/recover-scheduled-read-occurrences.js";

const target = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  resourceId: "00000000-0000-4000-8000-000000000002",
  expectedMessageId: "00000000-0000-4000-8000-000000000003"
};
const args = ["seed", "--manifest", "entries.json", "--limit", "2"];
describe("bounded scheduled read support invocation", () => {
  it("requires a finite explicit bound and exact metadata identities", () => {
    expect(parseRecoveryInvocation(args, JSON.stringify([target]))).toEqual({
      mode: "seed",
      manifestPath: "entries.json",
      limit: 2,
      targets: [target]
    });
    for (const bad of [
      [],
      [target, target],
      [{ ...target, text: "private" }],
      [{ ...target, expectedMessageId: "wrong" }]
    ]) {
      expect(() => parseRecoveryInvocation(args, JSON.stringify(bad))).toThrow();
    }
    expect(() => parseRecoveryInvocation(["other", ...args.slice(1)], "[]")).toThrow();
    expect(() => parseRecoveryInvocation(args.slice(0, 3), JSON.stringify([target]))).toThrow();
    expect(() =>
      parseRecoveryInvocation([...args.slice(0, 4), "1001"], JSON.stringify([target]))
    ).toThrow();
  });
});

describe("manifest rejection before runtime effects", () => {
  it.each(["0", "-1", "1.5", "1e2", "1001", "99999999999999999999999"])(
    "rejects invalid bound %s",
    (bound) => {
      expect(() =>
        parseRecoveryInvocation([...args.slice(0, 4), bound], JSON.stringify([target]))
      ).toThrow();
    }
  );
  it("rejects malformed JSON, non-array data, missing/extra fields and oversize input", () => {
    for (const value of [
      "{",
      "null",
      "{}",
      JSON.stringify([{ actorUserId: target.actorUserId }]),
      JSON.stringify([{ ...target, expectedMessageId: 1 }]),
      " ".repeat(256001)
    ])
      expect(() => parseRecoveryInvocation(args, value)).toThrow();
    expect(() => parseRecoveryInvocation([...args, "--all"], JSON.stringify([target]))).toThrow();
    expect(() =>
      parseRecoveryInvocation(
        ["recover", "--other", "entries.json", "--limit", "2"],
        JSON.stringify([target])
      )
    ).toThrow();
  });
  it("bounds entries independently of bytes and rejects UUID case aliases", () => {
    const second = { ...target, resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    expect(() =>
      parseRecoveryInvocation([...args.slice(0, 4), "1"], JSON.stringify([target, second]))
    ).toThrow();
    expect(() =>
      parseRecoveryInvocation(
        args,
        JSON.stringify([second, { ...second, resourceId: second.resourceId.toUpperCase() }])
      )
    ).toThrow();
    expect(
      parseRecoveryInvocation(["recover", ...args.slice(1)], JSON.stringify([second])).mode
    ).toBe("recover");
  });
});
