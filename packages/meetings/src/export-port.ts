import type { AccessContext } from "@moss/db";

interface MeetingExportIdentity {
  readonly sourceId: string;
  readonly version: number;
}

/**
 * Meetings' required private-copy capability. The host supplies an owner-private adapter;
 * this module neither imports another feature module nor accepts arbitrary destinations.
 */
export interface MeetingPrivateExportPort {
  inspect(
    access: AccessContext,
    identity: MeetingExportIdentity,
    content: string
  ): Promise<{
    readonly noteReference: string;
    readonly status: "missing" | "unchanged" | "conflict";
  }>;
  createOrInspect(
    access: AccessContext,
    identity: MeetingExportIdentity,
    content: string
  ): Promise<{
    readonly noteReference: string;
    readonly status: "written" | "unchanged" | "conflict";
  }>;
  queueIndex(
    access: AccessContext,
    identity: MeetingExportIdentity,
    content: string
  ): Promise<
    | { readonly status: "queued"; readonly jobId: string }
    | { readonly status: "delayed" | "conflict" }
  >;
}
