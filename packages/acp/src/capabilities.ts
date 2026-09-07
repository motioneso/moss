/**
 * The agent capability gate from spec section 7 (#2369 slice 1).
 *
 * An agent may be offered on a surface only if it meets that surface's row.
 * Checked at adapter start from the `initialize` response, never assumed.
 */

import type { InitializeResponse } from "@agentclientprotocol/sdk";

export type AcpSurface = "workshop" | "chat";

export class AcpCapabilityError extends Error {
  constructor(
    readonly surface: AcpSurface,
    reason: string
  ) {
    super(
      `This agent cannot run in the ${surface === "workshop" ? "Workshop" : "chat"}: ${reason}`
    );
    this.name = "AcpCapabilityError";
  }
}

/**
 * Fail closed when the agent cannot serve this surface. The Workshop needs the
 * core session lifecycle plus HTTP tool-server handover; the chat row additionally
 * needs switchable built-ins (used by slice 2, checked by the same function).
 */
export function checkAgentCapabilities(surface: AcpSurface, response: InitializeResponse): void {
  const caps = response.agentCapabilities;
  if (!caps) {
    throw new AcpCapabilityError(surface, "it did not describe what it can do.");
  }
  if (response.protocolVersion !== 1) {
    throw new AcpCapabilityError(
      surface,
      `it speaks protocol version ${response.protocolVersion}, and this client is pinned to version 1.`
    );
  }
  if (caps.mcpCapabilities?.http !== true) {
    throw new AcpCapabilityError(
      surface,
      "it cannot take the Moss tool server over HTTP, so it would work with no tools."
    );
  }
  if (surface === "chat") {
    // The chat launch profile switches the agent's own shell and file writes off.
    // Protocol v1 exposes no flag proving an agent honors that switch, so the chat
    // row cannot pass on the wire yet — slice 2 carries the explicit base tool list.
    throw new AcpCapabilityError(
      surface,
      "no agent has proven it switches its own shell and file writes off."
    );
  }
}
