/** #2236 slice 1: shared contract for the single-row-per-user scratchpad. */

export const SCRATCHPAD_MAX_CHARS = 64000;
export const SCRATCHPAD_DEFAULT_SHORTCUT = "mod+shift+s";

export interface ScratchpadResponse {
  readonly body: string;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly maxChars: 64000;
  readonly syncToNotes: boolean;
  readonly notesFolderConfigured: boolean;
  readonly shortcut: string;
}

export interface PutScratchpadRequest {
  readonly body: string;
  readonly revision: number;
}

export interface PutScratchpadResponse {
  readonly revision: number;
  readonly updatedAt: string;
}

/** Sent as the 409 response body when a PUT's revision no longer matches the stored row. */
export interface ScratchpadConflictResponse {
  readonly error: "scratchpad_conflict";
  readonly body: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface AppendScratchpadRequest {
  readonly text: string;
}

export interface AppendScratchpadResponse {
  readonly revision: number;
  readonly updatedAt: string;
  /** The exact text that was appended, including any leading newline, so the caller can quote it. */
  readonly appended: string;
}

export interface PatchScratchpadSettingsRequest {
  readonly syncToNotes?: boolean;
  readonly shortcut?: string;
}

export interface PatchScratchpadSettingsResponse {
  readonly syncToNotes: boolean;
  readonly shortcut: string;
}
