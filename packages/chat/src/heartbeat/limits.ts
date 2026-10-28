import type { HeartbeatCadenceMinutes } from "@moss/shared";

/** Shipped defaults. The owner changes cadence in Settings; nothing here is an env var. */
export const HEARTBEAT_DEFAULT_CADENCE_MINUTES: HeartbeatCadenceMinutes = 60;
export const HEARTBEAT_SWEEP_CRON = "*/5 * * * *";
export const HEARTBEAT_SWEEP_MAX_OWNERS = 200;
export const HEARTBEAT_RECENT_OCCURRENCES = 5;
