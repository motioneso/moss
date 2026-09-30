// Leaf file with no imports. The manifest imports the chat tools, which reach jobs.ts, and
// jobs.ts needs these names while the manifest is still evaluating.

export const BRIEFINGS_MODULE_ID = "briefings";
export const BRIEFINGS_RUN_QUEUE = "briefings-run";
