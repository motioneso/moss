// Notifications — in-app, actor-scoped delivery: a notification is a personal message whose
// `recipient_user_id` is always `app.current_actor_user_id()`, created inside that actor's
// `DataContextRunner` scope. It is NOT a cross-user / system-broadcast mechanism. Web push
// (#743 / #2227) is an optional, self-service opt-in fan-out of that same in-app notification
// to a browser, not a second notification system. See the manifest docblock for the full model
// and the specs (docs/superpowers/specs/2026-06-19-notifications-actor-scoped-hardening.md,
// docs/superpowers/specs/2026-09-04-743-web-push-notifications.md).
export * from "./manifest.js";
export * from "./metadata.js";
export * from "./digest.js";
export * from "./repository.js";
export * from "./routes.js";
export * from "./push-crypto.js";
export * from "./push-endpoint-policy.js";
export * from "./push-jobs.js";
export * from "./push-payload.js";
export * from "./push-subscriptions-repository.js";
export * from "./push-worker.js";
