import { describe, expect, it } from "vitest";

import type { InitializeResponse } from "@agentclientprotocol/sdk";

import { AcpCapabilityError, checkAgentCapabilities } from "./capabilities.js";

function workshopResponse(overrides: Partial<InitializeResponse> = {}): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true }
    },
    ...overrides
  } as InitializeResponse;
}

describe("checkAgentCapabilities", () => {
  it("passes a Workshop agent with HTTP tool handover", () => {
    expect(() => checkAgentCapabilities("workshop", workshopResponse())).not.toThrow();
  });

  it("fails closed when the agent cannot take the tool server", () => {
    const response = workshopResponse({
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: false, sse: true }
      }
    });
    expect(() => checkAgentCapabilities("workshop", response)).toThrow(AcpCapabilityError);
  });

  it("fails closed on a newer protocol version", () => {
    const response = workshopResponse({ protocolVersion: 2 });
    expect(() => checkAgentCapabilities("workshop", response)).toThrow(/pinned to version 1/);
  });

  it("fails the chat row closed: no on-wire proof of the switch-off", () => {
    expect(() => checkAgentCapabilities("chat", workshopResponse())).toThrow(AcpCapabilityError);
  });
});
