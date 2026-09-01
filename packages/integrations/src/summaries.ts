/** Fixed Moss-authored summary strings for the integration outcome envelope (#2175 Task 2/3). */
export const INTEGRATION_SUMMARY = {
  performedOk: "Action performed successfully.",
  readOk: "Read succeeded.",
  callFailed: "Call failed; see detail for the service's error.",
  blockedRead: "Unchanged result from earlier in this request.",
  blockedPerformed: "This was already done once in this request and was not done again.",
  truncated: "Result truncated at 8,000 characters; ask for a narrower query to see more.",
  requestRefused: "Call limit reached for this request; answer with what you have."
} as const;
