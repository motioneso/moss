/**
 * The agent capability gate from spec section 7 (slice 1, chat first).
 *
 * An agent may be offered on a profile only if it meets that profile's row.
 * Checked at adapter start from the `initialize` response, never assumed.
 */

import type { InitializeResponse } from "@agentclientprotocol/sdk";

import { getAcpProviderRow, type AcpProviderKind } from "./providers.js";

export type AcpProfile = "chat" | "workshop" | "unattended";
/** Pre-chat-first name; kept so history-era imports keep resolving. */
export type AcpSurface = AcpProfile;

export class AcpCapabilityError extends Error {
  constructor(
    readonly surface: AcpProfile,
    reason: string
  ) {
    super(`This agent cannot serve ${surface}: ${reason}`);
    this.name = "AcpCapabilityError";
  }
}

/**
 * Profile gate (slice 1 task 2): only `chat` is built. The other two values
 * are declared so the tool table keeps its columns, and rejected here with
 * "not built yet" before the table is consulted. Google's row is present and
 * marked unavailable with its reason until slice 2.
 */
export function checkAcpProfile(profile: AcpProfile, kind: AcpProviderKind): void {
  if (profile !== "chat") {
    throw new AcpCapabilityError(profile, `support for the ${profile} profile is not built yet.`);
  }
  const row = getAcpProviderRow(kind);
  if (!row.chatReady) {
    throw new AcpCapabilityError(
      profile,
      row.chatBlockReason ?? `the ${kind} provider is not ready for chat.`
    );
  }
}

/**
 * Fail closed when the agent cannot serve this profile. Every profile needs
 * the core session lifecycle plus HTTP tool-server handover; the version is
 * pinned to v1 and any other answer fails closed in plain English.
 */
export function checkAgentCapabilities(profile: AcpProfile, response: InitializeResponse): void {
  const caps = response.agentCapabilities;
  if (!caps) {
    throw new AcpCapabilityError(profile, "it did not describe what it can do.");
  }
  if (response.protocolVersion !== 1) {
    throw new AcpCapabilityError(
      profile,
      `it speaks protocol version ${response.protocolVersion}, and this client is pinned to version 1.`
    );
  }
  if (caps.mcpCapabilities?.http !== true) {
    throw new AcpCapabilityError(
      profile,
      "it cannot take the Moss tool server over HTTP, so it would work with no tools."
    );
  }
}
