/**
 * Fixed label lists for stored diagnostic log records. Admins see these labels on rows they do
 * not own, so they never carry free text. The stored table enforces the same lists with CHECK
 * constraints (packages/settings/sql/0357_diagnostic_log_records.sql). Adding a label needs a
 * new migration that replaces the constraint, plus an entry here.
 */

export const LOG_COMPONENTS = [
  "api",
  "worker",
  "auth",
  "connectors",
  "google-sync",
  "oauth",
  "email",
  "calendar",
  "news",
  "finance",
  "meetings",
  "sports",
  "jobs",
  "ai",
  "chat",
  "settings",
  "vault",
  "log",
  "other"
] as const;

export const LOG_CONNECTION_KINDS = [
  "google",
  "outlook",
  "imap",
  "home-assistant",
  "calendar",
  "news",
  "finance",
  "meetings",
  "sports"
] as const;

export const LOG_EVENT_CODES = [
  "auth-failed",
  "sync-failed",
  "connection-failed",
  "timeout",
  "helper-unavailable",
  "rate-limited",
  "job-failed",
  "crash",
  "startup-failed",
  "shutdown-failed",
  "log.dropped"
] as const;

export type LogComponent = (typeof LOG_COMPONENTS)[number];
export type LogConnectionKind = (typeof LOG_CONNECTION_KINDS)[number];
export type LogEventCode = (typeof LOG_EVENT_CODES)[number];
