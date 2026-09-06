// #2348 — moved to @moss/ai so both cli-runner and chat can use the exact same
// allowlist function without the two packages depending on each other (cli-runner
// already depends on chat, so chat depending on cli-runner would be circular; both
// already depend on ai). This file is now just a pointer to the real implementation —
// nothing here changed behavior, and every existing caller in this package keeps
// working unmodified.
export { buildSanitizedCliEnv } from "@moss/ai";
