import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_DECISION_MODELS,
  cloudflareDecisionBaseUrl,
  decisionModelDialect,
  isCloudflareAccountId,
  isCloudflareDecisionBaseUrl
} from "../../packages/shared/src/decision-model-presets.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE_ADDRESS = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai`;

describe("decisionModelDialect", () => {
  it.each([
    ["blank string", ""],
    ["null", null],
    ["undefined", undefined],
    ["TypeSafe", "https://api.typesafe.ai"],
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["Vercel AI Gateway", "https://ai-gateway.vercel.sh/typesafe/v1"],
    ["a host that merely contains the word cloudflare", "https://my-cloudflare-proxy.example/ai"],
    ["an unparseable address", "api.cloudflare.com/v1/systemone"]
  ])("is standard for %s", (_name, address) => {
    expect(decisionModelDialect(address)).toBe("standard");
  });

  it("is cloudflare for an account address on the api.cloudflare.com host", () => {
    expect(decisionModelDialect(CLOUDFLARE_ADDRESS)).toBe("cloudflare");
  });

  it("is cloudflare by host alone, not by the whole URL", () => {
    expect(decisionModelDialect("https://api.cloudflare.com/anything/else")).toBe("cloudflare");
  });
});

describe("Cloudflare account ids", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(isCloudflareAccountId(ACCOUNT_ID)).toBe(true);
  });

  it.each([
    ["31 characters", ACCOUNT_ID.slice(0, 31)],
    ["33 characters", ACCOUNT_ID + "0"],
    ["uppercase", ACCOUNT_ID.toUpperCase()],
    ["a path traversal attempt", "../0123456789abcdef0123456789ab"],
    ["non-hex characters", "0123456789abcdef0123456789abcg"]
  ])("refuses %s", (_name, value) => {
    expect(isCloudflareAccountId(value)).toBe(false);
  });
});

describe("cloudflareDecisionBaseUrl", () => {
  it("round-trips a valid id through the builder and the shape check", () => {
    const built = cloudflareDecisionBaseUrl(ACCOUNT_ID);
    expect(built).toBe(CLOUDFLARE_ADDRESS);
    expect(isCloudflareDecisionBaseUrl(built)).toBe(true);
  });

  it("throws rather than building an address from a bad id", () => {
    expect(() => cloudflareDecisionBaseUrl("../escape")).toThrow(/32 lowercase hex/);
  });
});

describe("isCloudflareDecisionBaseUrl", () => {
  it("accepts the exact account-ai shape only", () => {
    expect(isCloudflareDecisionBaseUrl(CLOUDFLARE_ADDRESS)).toBe(true);
  });

  it.each([
    ["another host", "https://example.test/client/v4/accounts/" + ACCOUNT_ID + "/ai"],
    ["plain http", CLOUDFLARE_ADDRESS.replace("https://", "http://")],
    ["an uppercase id", CLOUDFLARE_ADDRESS.replace(ACCOUNT_ID, ACCOUNT_ID.toUpperCase())],
    ["a missing /ai suffix", CLOUDFLARE_ADDRESS.replace("/ai", "")],
    ["an extra path segment", CLOUDFLARE_ADDRESS + "/extra"],
    ["a query string", CLOUDFLARE_ADDRESS + "?redirect=https://evil.test"],
    ["a traversal id", "https://api.cloudflare.com/client/v4/accounts/../ai"]
  ])("refuses %s", (_name, address) => {
    expect(isCloudflareDecisionBaseUrl(address)).toBe(false);
  });
});

describe("CLOUDFLARE_DECISION_MODELS", () => {
  it("is the fixed Clef family", () => {
    expect(CLOUDFLARE_DECISION_MODELS).toEqual(["clef", "clef-flash"]);
  });
});
