import type { HeartbeatCadenceMinutes } from "@moss/shared";

/** Shipped defaults. The owner changes cadence in Settings; nothing here is an env var. */
export const HEARTBEAT_DEFAULT_CADENCE_MINUTES: HeartbeatCadenceMinutes = 60;
export const HEARTBEAT_SWEEP_CRON = "*/5 * * * *";
export const HEARTBEAT_SWEEP_MAX_OWNERS = 200;
export const HEARTBEAT_RECENT_OCCURRENCES = 5;

/** Generation allowance per owner local day, and the bounds of one attempt. */
export const HEARTBEAT_DAILY_ATTEMPTS = 6;
export const HEARTBEAT_MAX_INPUT_TOKENS = 8_000;
export const HEARTBEAT_MAX_OUTPUT_TOKENS = 800;
export const HEARTBEAT_GENERATION_TIMEOUT_MS = 60_000;

/** What one beat reads from each source, and the bounds on what the model may write. */
export const HEARTBEAT_READ_HORIZON_HOURS = 24;
export const HEARTBEAT_READ_LIMIT = 20;
export const HEARTBEAT_NOTE_MAX_CHARS = 280;
export const HEARTBEAT_INTRO_MAX_CHARS = 200;
