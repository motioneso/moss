export { MossAcpClient } from "./client.js";
export type {
  AcpClientEvents,
  AcpPermissionDecider,
  AcpPromptOptions,
  AcpPromptResult,
  AcpSessionHandle,
  AcpSetModelResult,
  AcpToolAnnouncement,
  AcpToolServer
} from "./client.js";
export { acceptedOptionValues, findModelOption } from "./client.js";
export { AcpCapabilityError, checkAcpProfile, checkAgentCapabilities } from "./capabilities.js";
export type { AcpProfile, AcpSurface } from "./capabilities.js";
export { getAcpProviderRow, listAcpProviderRows } from "./providers.js";
export type { AcpProviderKind, AcpProviderRow } from "./providers.js";
export {
  acpRequestFamily,
  classifyAcpPermission,
  decideAcpPermission,
  extractAcpCommand,
  extractAcpPaths,
  extractAcpWebAddress,
  isInsideSessionFolder,
  isPrivateWebAddress,
  selectAllowOptionId,
  toolNameFromMeta,
  ACP_DESTRUCTIVE_TOOL_NAMES,
  ACP_PATH_INPUT_KEYS
} from "./permissions.js";
export {
  acpToolNamesIn,
  launchOffList,
  lookupAcpToolFamily,
  ACP_MOSS_TOOL_PREFIX
} from "./tool-table.js";
export type { AcpToolFamily, AcpToolRow } from "./tool-table.js";
export type {
  AcpBuiltInRequest,
  AcpDenyReason,
  AcpPermissionVerdict,
  AcpSessionFolders
} from "./permissions.js";
/** The protocol's file-location shape, re-exported so callers need no SDK dependency. */
export type { ToolCallLocation as AcpToolCallLocation } from "@agentclientprotocol/sdk";
export { createTunnelStream } from "./stream.js";
export type { AcpExecPoll, AcpTunnel } from "./tunnel.js";
/** Re-exported so tunnel backers can build protocol handlers without an SDK dependency. */
export { ClientSideConnection } from "@agentclientprotocol/sdk";
