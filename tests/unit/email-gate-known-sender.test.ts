import { describe, expect, it, vi } from "vitest";
import {
  extractEmailSignals,
  extractEmailSignalsBatch,
  senderAddress,
  type EmailExtractDeps
} from "../../packages/connectors/src/email-extract.js";
import { parsed } from "./email-gate.test.js";

const LINE = "someone this user already deals with";

function promptsOf(deps: EmailExtractDeps): string[] {
  return (deps.runChat as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}

describe("known sender line", () => {
  it("is present when knownSender is true and absent otherwise", async () => {
    const deps: EmailExtractDeps = {
      runChat: vi.fn(async () => ({ text: JSON.stringify({ gate: "nothing" }) }))
    };
    await extractEmailSignals(parsed({}), deps, { knownSender: true });
    await extractEmailSignals(parsed({}), deps);
    const calls = promptsOf(deps);
    expect(calls[0]).toContain(LINE);
    expect(calls[1]).not.toContain(LINE);
  });
  it("batch path marks only the matching addresses", async () => {
    const deps: EmailExtractDeps = {
      runChat: vi.fn(async () => ({
        text: JSON.stringify({
          results: [
            { index: 0, value: { gate: "nothing", category: "noise", confidence: 0.9 } },
            { index: 1, value: { gate: "nothing", category: "noise", confidence: 0.9 } }
          ]
        })
      }))
    };
    await extractEmailSignalsBatch(
      [
        parsed({ from: "Sarah <sarah@kim.example>" }),
        parsed({ externalId: "m2", from: "shop@promo.example" })
      ],
      deps,
      { knownSenders: new Set(["sarah@kim.example"]) }
    );
    const prompt = promptsOf(deps)[0]!;
    expect(prompt.indexOf(LINE)).toBeGreaterThan(-1);
    expect(prompt.match(new RegExp(LINE, "g"))?.length).toBe(1);
  });
  it("senderAddress strips the display name and lower-cases", () => {
    expect(senderAddress("Sarah Kim <Sarah@Kim.Example>")).toBe("sarah@kim.example");
    expect(senderAddress("  shop@promo.example ")).toBe("shop@promo.example");
  });
});
