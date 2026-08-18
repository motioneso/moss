# Moss Self-Diagnostics

**Status:** Approved

**Date:** 2026-08-17

**Owner:** Ben

**GitHub:** #1586

## Problem Statement

Moss can describe what the product shows, but it cannot inspect enough of the running platform to
explain why that behavior occurred. When a user's news is stale, for example, Moss can see old
headlines but cannot reliably report when the refresh pipeline last ran, whether it succeeded, why
it failed, or what version of the relevant behavior is deployed. The user must leave Moss and ask a
separate technical agent or operator to inspect the application.

This is a platform-wide capability gap rather than a news-only bug. Users asking Moss about data or
behavior inside Moss should be able to get an evidence-based answer from Moss itself, within their
existing permissions and without exposing secrets or private data.

## Solution

Give Moss a constrained, read-only platform inspection capability comparable to the safe parts of a
coding agent inspecting a deployed application. Moss can inspect the deployed version and bounded
source excerpts, safe runtime health, actor-visible operational state, and structured recent failure
context. Modules publish their own safe diagnostic facts through one shared inspection seam rather
than exposing their storage or internals directly.

Add a separate confirmed news refresh action that reuses the existing refresh pipeline. A user can
ask whether their news is fresh, receive the last attempt, success, and failure context, ask Moss to
refresh it, approve the action through the normal confirmation flow, and then verify that the
refresh completed.

## User Stories

1. As a Moss user, I want to ask whether my news is fresh, so that I can trust the information I am
   seeing.
2. As a Moss user, I want Moss to report when my news was last refreshed successfully, so that I can
   judge its age.
3. As a Moss user, I want Moss to distinguish the latest refresh attempt from the latest successful
   refresh, so that a recent failure does not look like fresh content.
4. As a Moss user, I want Moss to explain a failed or stuck refresh in safe plain language, so that I
   understand why the feed is stale.
5. As a Moss user, I want Moss to cite the operational facts behind its answer, so that its diagnosis
   is evidence-based rather than a guess.
6. As a Moss user, I want to ask Moss to refresh my news, so that I can recover from stale data
   without leaving the conversation.
7. As a Moss user, I want a refresh request to require the same permission and confirmation flow as
   other assistant actions, so that Moss cannot change platform state unexpectedly.
8. As a Moss user, I want Moss to tell me when a refresh is queued rather than claiming it has
   completed, so that asynchronous work is represented honestly.
9. As a Moss user, I want Moss to recheck the news after a refresh, so that I can verify the freshness
   timestamp and content actually changed.
10. As a Moss user, I want diagnostics to respect my account and module visibility, so that I never
    see another user's operational data.
11. As a Moss user, I want diagnostic answers to omit secrets, credentials, private content, and raw
    provider responses, so that troubleshooting does not weaken my privacy or security.
12. As a Moss user, I want Moss to inspect other Moss features through the same conversational
    capability, so that each pipeline does not require a separate troubleshooting experience.
13. As a module developer, I want my module to publish a small structured diagnostic view, so that
    Moss can explain the module without importing its internals or querying its tables directly.
14. As a module developer, I want diagnostic results to identify their source and observation time,
    so that Moss can distinguish deployed code, runtime health, and stored state.
15. As a module developer, I want source inspection to be bounded to safe application text, so that
    Moss can understand deployed behavior without gaining general filesystem or shell access.
16. As an operator, I want Moss to report the deployed version and safe runtime health, so that I can
    determine whether a known fix is actually running.
17. As an operator, I want instance-wide facts to remain admin-only or redacted, so that ordinary
    users receive useful answers without learning sensitive host details.
18. As an operator, I want diagnostic output to be small and structured, so that it remains auditable
    and does not flood the assistant context with raw logs.
19. As a security reviewer, I want read tools to receive only read-capable services, so that a
    diagnostic tool cannot mutate state or bypass confirmation.
20. As a security reviewer, I want all diagnostic queries to preserve module isolation, RLS, and
    actor scope, so that self-inspection does not create a privileged back door.
21. As a security reviewer, I want operational text limited to trusted metadata rather than private
    or externally supplied bodies, so that diagnostics do not introduce a prompt-injection channel.
22. As a maintainer, I want diagnostics to reuse existing app-map, host-diagnostic, structured-error,
    action-audit, and module refresh seams, so that there is one coherent capability instead of
    parallel operations frameworks.

## Implementation Decisions

- Add one read-only assistant tool for platform inspection. It accepts a bounded question or query
  and returns structured observations for source/version, runtime health, and operational state.
- Back the tool with one injected platform diagnostics service composed at the application boundary.
  The service aggregates existing public read ports; modules do not import one another's internals.
- Keep module-specific knowledge in module-owned diagnostic providers. Each provider returns a
  small, safe projection of actor-visible state with a domain/provider identifier, observation time,
  status, summary, and any recognized remediation action identifier.
- Reuse the existing app-map/version data, safe host diagnostics, actor-scoped structured errors, and
  action audit where applicable. Existing sanitization remains authoritative; do not duplicate a
  second host diagnostics implementation.
- Give authenticated users only actor-scoped and module-visible observations. Keep instance-wide
  host facts admin-only or redact them for non-admin users. Admin status never bypasses private-data
  RLS.
- Add a bounded deployed-source inspector using platform filesystem APIs rather than a shell. Search
  and reads are limited by allowed application source/text roots, result count, excerpt size, and
  total bytes.
- Exclude environment and secret-bearing configuration, VCS metadata, dependencies, build
  artifacts, user data, and vault content from source inspection. Return a safe relative source path
  and line excerpt as provenance.
- Do not expose raw stdout, container logs, database access, arbitrary filesystem access, or a
  generic command runner. Operational events are structured, bounded, sanitized metadata only.
- Extend the news module's owner-scoped refresh state so the latest request/attempt, latest success,
  latest failure, failure kind, current state/generation, and current snapshot time can be
  distinguished. Add a new module-owned migration; do not modify an applied migration.
- Include enough bounded news metadata to judge freshness, such as snapshot age and item count.
  Per-source diagnostics are deferred until the aggregate state proves insufficient.
- Add a module-specific assistant write action for refreshing news. It calls the existing shared
  news refresh trigger and uses the gateway's normal permission, confirmation, and audit behavior.
- Treat refresh as asynchronous. The action reports accepted/queued/current state, and inspection is
  used to observe eventual success or failure; it does not claim completion when work is only queued.
- Do not turn the platform inspection service into a generic action executor. Remediation actions
  stay module-specific and individually permissioned.
- All assistant output continues to obey existing tool-output size limits and sanitization.

## Testing Decisions

- The primary acceptance test uses the real assistant conversation/tool gateway, the highest
  existing seam: begin with stale or failing news, ask "Is my news fresh? Why not?", verify Moss uses
  platform inspection and cites the last success, attempt, and safe failure context, ask Moss to
  refresh, approve the confirmation, allow the queued job to complete, then verify reinspection shows
  updated freshness and content.
- Assert external behavior rather than provider composition or internal call order. The test should
  fail if Moss cannot diagnose, cannot safely request recovery, misstates queued work as completed,
  or cannot verify the result.
- Add focused integration coverage for news refresh-state history, owner scoping/RLS, diagnostic
  redaction, and the confirmed refresh action.
- Add one bounded-source-inspection test covering allowed reads/searches, excluded roots, traversal
  rejection, result/byte limits, and secret-like content rejection.
- Reuse prior art from app-map assistant-tool tests, host-diagnostics integration and sanitizer tests,
  structured recent-error tests, news chat-tool and refresh-job tests, and assistant gateway
  confirmation/audit tests.
- Include negative assertions that ordinary users cannot see instance-only facts, users cannot see
  another actor's state, diagnostic output contains no raw secrets or private/provider bodies, and a
  read inspection cannot obtain write-capable services.
- Live-path verification must exercise the feature through a real Moss conversation on a live dev
  instance and record the diagnosis, confirmation, refresh, and successful reinspection evidence on
  the implementation PR.

## Out of Scope

- Raw or unrestricted log viewing.
- Raw database queries or general database browsing.
- General shell or arbitrary command execution.
- Arbitrary filesystem access, vault access, or user-content inspection.
- Environment dumps, credentials, tokens, connection strings, raw stack traces, or provider bodies.
- Bypassing module isolation, RLS, feature grants, permissions, confirmation, or audit rules.
- User-account deletion or other general administrative mutations.
- A generic remediation/action framework.
- A metrics, tracing, or observability platform.
- Detailed per-source news diagnostics unless aggregate diagnostics cannot explain the accepted use
  case.

## Further Notes

- The motivating news-staleness case is the first complete provider and acceptance path, not a
  news-only architecture.
- The production runtime already contains the deployed application source and version metadata, so
  the MVP does not need a second source bundle or a new dependency.
- The intended product boundary is: Moss can inspect itself much like a constrained coding agent can
  inspect a deployed application, but it cannot gain operator-grade unrestricted access.
