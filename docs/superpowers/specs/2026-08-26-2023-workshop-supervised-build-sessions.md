# Workshop supervised build sessions

**Status:** Approved
**Date:** 2026-08-26
**Owner:** Ben
**GitHub:** #2023

---

## Problem Statement

Workshop can start a module build, list builds, show a coarse phase, and present a finished draft, but it does not yet feel like a place where a person and a build agent work together. A user cannot reliably tell whether the agent is doing useful work, stalled, waiting for an answer, retrying after an interruption, or merely still labeled “Building.” The existing last-activity timestamp is truthful but too limited to explain what is happening or what the user should do next.

The user also loses agency once building starts. Requirements are gathered outside Workshop, the plan is presented as a one-time gate, and the background builder has no purpose-built conversational surface through which the user can steer the work, answer questions, request a check, or test an intermediate result. Builders can inspect a separate administrative terminal, but it is not attached to the Workshop build and is not a coherent second view of the same agent session.

The result is a trust problem. A build can be alive, dead, or recovering while presenting nearly the same UI. Users either wait blindly, ask an operator to inspect production, or abandon Workshop and return to the normal development process. That defeats the product goal: a user should be able to create a real Moss Module from inside Moss, with enough visibility and control to trust the outcome.

## Solution

Make Workshop the complete home for a supervised Module build.

The Workshop dashboard remains the place to see current and previous builds. A **New module** action starts a build-specific conversation inside Workshop. The Workshop agent conducts a focused requirements conversation, produces one current plan, and lets the user revise that plan conversationally before approving it. Once approved, the same conversation becomes the supervision surface for the live build: the user sees structured, server-backed build events, receives questions from the agent, can steer or ask it to test something, and can stop the work.

The build detail view presents three truthful dimensions rather than one overloaded “Building” label:

- **Phase:** what the build is trying to accomplish, such as understanding the request, preparing the plan, writing the specification, writing checks, writing code, validating, or preparing the draft.
- **Health:** whether the worker is queued, working, stalled, retrying, failed, cancelled, or complete, derived from persisted heartbeats and queue state rather than cosmetic timers.
- **Attention:** whether the build can continue alone or needs the user to answer a question, approve the plan, review a draft, or resolve a failure.

The dashboard shows a concise projection of those facts. The build detail page shows the purpose-built conversation and an ordered Build timeline. An **Open terminal** action opens a new browser tab using the existing terminal presentation and PTY transport, but attaches to the exact owner-authorized Workshop agent session instead of opening a separate generic shell. Chat and terminal are two views of one build session, not two agents.

The existing Module validator, isolated build workspace, draft lifecycle, human Ship action, restart behavior, and cleanup path remain the bones of the system. Workshop does not upload or publish Modules externally and cannot modify unrelated Moss source or normal runtime state. It produces a real Module that must pass the same checks as one built through the normal development process.

## User Stories

1. As an authorized Workshop user, I want to start a new Module from the Workshop page, so that I do not have to begin in the global chat drawer.
2. As a user, I want Workshop to prevent a duplicate start while I already have an active build, so that one click cannot create overlapping projects or agents.
3. As a user, I want an existing active build to open instead of creating another one, so that resuming is the default behavior.
4. As a nontechnical user, I want the Workshop agent to ask focused questions about what I want, so that I do not need to know the Module contract.
5. As a builder, I want to give detailed technical constraints during discovery, so that Workshop does not flatten my request into a beginner-only flow.
6. As a user, I want the requirements conversation to persist across navigation and restart, so that I never have to repeat the request.
7. As a user, I want Workshop to tell me when my request cannot safely be implemented as a Module, so that it fails before spending time building.
8. As a user, I want one current plan that states what the Module does, reaches, stores, and runs, so that I can review the intended result.
9. As a user, I want to change the plan by talking to the Workshop agent, so that correcting it feels like part of the same conversation.
10. As a user, I want an amended plan to supersede the previous plan clearly, so that only one version can be approved.
11. As a user, I want to approve the current plan explicitly, so that the agent cannot begin from an obsolete or misunderstood plan.
12. As a user, I do not want dollar budgets, spend totals, or estimated build durations in the plan, so that subscription-backed usage is not presented as misleading precision.
13. As a user, I want the dashboard to show what phase each active build is in, so that I can understand its current purpose at a glance.
14. As a user, I want the dashboard to distinguish Working from Stalled, so that a dead worker is never represented as healthy.
15. As a user, I want to see the last real worker activity in my configured timezone, so that the status is grounded in persisted evidence.
16. As a user, I want to see when a build is queued, so that waiting for a worker is not confused with active generation.
17. As a user, I want to see when a build is retrying and which attempt it is on, so that automatic recovery is visible.
18. As a user, I want a stalled build to say what Moss will do next, so that I know whether to wait, retry, stop, or intervene.
19. As a user, I want a short ordered Build timeline, so that I can reconstruct queued, started, phase-changed, stalled, retried, questioned, answered, completed, failed, and cancelled events.
20. As a user, I want status changes to come from the server, so that reloading or opening another browser shows the same truth.
21. As a user, I want the Workshop agent to ask me a question during a build, so that it does not guess when a decision matters.
22. As a user, I want a build that asks a question to move into Needs you, so that I can tell it is waiting on me rather than still working.
23. As a user, I want to answer the question in the build conversation, so that the same agent can continue with the new information.
24. As a user, I want to send steering guidance while the agent works, so that I can correct direction before the draft is finished.
25. As a user, I want the agent to acknowledge received steering, so that I know my message reached the live session.
26. As a user, I want messages to be delivered once, so that reconnects or retries cannot repeat an instruction.
27. As a user, I want to ask the agent to run a check or inspect an intermediate result, so that testing is part of the Workshop workflow.
28. As a user, I want to navigate away and return without losing the conversation or Build timeline, so that Workshop does not monopolize the app.
29. As a user, I want a notification when the build needs me, fails, or reaches a draft, so that I do not have to watch continuously.
30. As a builder, I want an Open terminal action on the build detail page, so that I can inspect or interact with the exact live agent session.
31. As a builder, I want the terminal to open in a new tab, so that I can keep the polished Workshop view open beside it.
32. As a builder, I want the terminal to attach to the existing build session rather than start another shell or agent, so that both views describe the same work.
33. As a builder, I want terminal access to be owner-authorized and short-lived, so that another user cannot attach to my build.
34. As a user, I want the polished chat to remain the primary interface, so that terminal knowledge is optional.
35. As a user, I want a disconnected terminal to say that the build is reconnecting or unavailable, so that a blank terminal is not mistaken for inactivity.
36. As a user, I want Stop to interrupt the live agent and cancel its actionable queue work promptly, so that cancelling is not merely a label change.
37. As a user, I want Stop and Discard to confirm success immediately and persist after reload, so that controls never appear inert.
38. As a user, I want a routine app or worker restart to produce an explicit recovery state, so that interruption is not hidden behind Building.
39. As a user, I want an interrupted build to resume from durable state rather than create a duplicate build, so that recovery does not lose work.
40. As a user, I want a failed recovery to become Failed with a useful explanation, so that retries cannot continue silently forever.
41. As a user, I want the finished draft to open from the same build detail page, so that supervision flows naturally into review.
42. As a user, I want to test the actual running draft, so that I judge the Module rather than an agent’s description of it.
43. As a user, I want to request a change from the draft and return to the same Workshop conversation, so that refinement preserves intent and history.
44. As a user, I want shipping to remain an explicit human action, so that the agent cannot grant its own work broader authority.
45. As a user, I want a shipped Module to behave like one built through the normal development process, so that Workshop does not create a second-class artifact.
46. As a user, I want a test Module to survive the documented restart and render through real navigation, so that Workshop success is proven end to end.
47. As a user, I want to remove and purge an unwanted Module cleanly, so that experiments leave no Module, build session, queue job, or data behind.
48. As a household member, I want another user’s draft, messages, terminal, and Build timeline to remain private, so that Workshop preserves normal owner isolation.
49. As an operator, I want Workshop builds isolated from Moss core source and unrelated runtime data, so that a bad build cannot break normal Moss functionality.
50. As an operator, I want no orphan multiplexer sessions after completion, cancellation, failure, or restart, so that Workshop does not leak host resources.
51. As an operator, I want persisted Build timeline entries to exclude secrets and raw terminal output, so that observability does not create a credential leak.
52. As an operator, I want a real live-path proof before this redesign is marked Done, so that green component tests cannot hide a dead assembled workflow.

## Implementation Decisions

- This spec evolves the approved Workshop architecture rather than replacing the Module-building pipeline. It preserves the existing Module validator, isolated build directories, background job execution, author-only drafts, human shipping, Module enablement, and cleanup lifecycle.
- The primary entry point moves into Workshop. The global chat may deep-link to or suggest Workshop, but starting and supervising a build no longer depends on keeping the global drawer open.
- The product-facing noun is **Module**, not project. UI actions use “New module” and “Build”; “project” is not introduced as a new domain object.
- Access remains restricted to the currently authorized Workshop audience for this version. Expanding Module building to non-admin household members is a separate authorization and product decision.
- One owner may have at most one nonterminal Workshop build at a time. Start is idempotent: repeated submission or a double click returns the existing build rather than creating another row or agent session.
- A build owns one durable Workshop conversation from discovery through refinement. User messages, agent messages, questions, answers, plan revisions, and structured system events are associated with the build and owner.
- The Workshop conversation is separate from the raw terminal byte stream. Persist only user-visible messages and structured Build timeline events. Raw PTY output remains ephemeral, owner-authorized, and absent from server logs and build records.
- The build agent uses the configured provider through the existing provider-agnostic engine and multiplexer abstractions. The design must not hard-code Codex, Claude, Gemini, tmux, or Herdr.
- The purpose-built Workshop chat and the terminal are two clients of the same live build session. Sending input from either surface must not launch a second agent.
- Reuse the existing terminal renderer, fit behavior, bidirectional transport, and one-time ticket pattern. Do not reuse the existing generic admin-terminal authorization or shell-opening behavior as the build contract. A Workshop terminal ticket is owner-scoped to one build and attaches only to that build’s existing session.
- The terminal opens in a new tab. It is available only while a live build session exists; queued, retrying, completed, failed, and cancelled builds show an explanatory unavailable state rather than opening a new shell.
- The normal Workshop experience is a purpose-built conversation and Build timeline. No terminal is required to start, steer, review, ship, or remove a Module.
- Plan revision remains conversational. There is one actionable plan card; a change request produces a new version and marks the old version superseded. No raw JSON or separate configuration form is introduced.
- Plan content retains what the Module does, reaches, keeps, and when it runs. Dollar budget, spend, estimated build time, and rough duration are removed from the Workshop contract and UI.
- Build status is projected from three orthogonal facts: phase, health, and attention. The API returns this projection consistently for dashboard and detail views rather than asking each frontend component to infer it independently.
- Build phases cover discovery, plan preparation, plan review, specification, checks, implementation, validation, and draft preparation. User-facing copy remains friendly and may group internal steps, but it must never invent progress.
- Health is computed from persisted heartbeat and queue attempt state. A worker heartbeat updates at the established short interval. After four missed heartbeat intervals, the build is displayed as Stalled even if the queue still calls the job active.
- Retrying is a real queue state and includes the current attempt and configured retry limit. Workshop may show an actual scheduled retry event or “retrying now,” but it does not show a speculative completion time.
- Attention is explicit and durable: none, question, plan approval, draft review, or failure action. A question pauses the agent’s current decision path until the owning user answers; it is not represented as generic working.
- Add an append-only Build timeline for meaningful server events. Events include created, discovery started, plan proposed, plan superseded, plan approved, queued, worker started, phase changed, question asked, answer received, steering received, heartbeat lost, retry scheduled, worker resumed, draft ready, failed, cancelled, shipped, and removed.
- Timeline writes are idempotent. Queue retries, reconnects, and duplicate client submissions cannot create duplicate semantic events or deliver the same user message twice.
- The dashboard remains a summary grouped by Needs you, Building now, and Live. Active rows show phase, health, last activity in the user’s timezone, and the next required action. The detail page contains the conversation, Build timeline, plan, controls, and draft link.
- Stop becomes an interrupt, not only a database status update. It persists cancellation, prevents further continuation jobs, cancels or invalidates the exact active queue attempt, kills the exact multiplexer session, and records one cancellation event. Cleanup must be safe when any of those resources already disappeared.
- Restart recovery is an ordinary supported path. On worker loss, the heartbeat becomes stale promptly, the UI becomes Stalled or Retrying, and a reclaimed attempt resumes the same build. Recovery cannot create overlapping builder sessions.
- Agent questions and messages use a structured build-session channel rather than scraping arbitrary terminal prose into the UI. The raw terminal remains available when a builder needs the unfiltered view.
- Secrets, provider credentials, auth tokens, terminal tickets, raw terminal output, and private prompts never enter queue payloads, API logs, Build timeline data, notifications, or another user’s response. Queue payloads remain metadata-only.
- The build agent remains constrained to the build’s isolated source directory and the existing Module-building capabilities. It may read approved host examples and use allowed research, but it may not modify Moss core source, deployment configuration, unrelated Modules, or production data.
- Shipping remains a human action and uses the existing validation and draft-promotion path. This spec does not grant the build agent installation, enablement, publishing, or external-upload authority.
- The redesigned UI uses existing Moss design-system primitives and tokens. Before implementation, the design pass must cover dashboard summary, new-build conversation, plan review, active working, Needs you, stalled/retrying, failure, draft-ready, terminal-unavailable, empty, loading, and broken states.
- Existing status and cancel improvements from #1990 are baseline behavior, not the final interaction model. This follow-on must not regress their server-backed timestamps, owner isolation, or no-estimates policy.

## Testing Decisions

- The decisive seam is one live Playwright journey through the real Workshop UI on a live instance with a real configured provider. It starts a simple Module, completes discovery, revises and approves the plan, observes a real phase change, steers the live agent, answers a build-time question, attaches the terminal to the same session, reaches a draft, requests a change, ships, restarts Moss, opens the Module through real navigation, removes it, and verifies cleanup.
- The live journey must use executable DOM, network, database, queue, and bounded process assertions. Screenshots and a green headless exit code alone are not acceptance evidence.
- The live journey must assert exactly one build row and one live builder session are created from one start action.
- The live journey must prove dashboard and detail views project the same server-backed phase, health, attention, and last-activity state.
- The live journey must interrupt the worker or app once, then assert the UI changes from Working to Stalled or Retrying, the same build resumes, and no duplicate agent session appears.
- The live journey must verify a steering message is acknowledged by the same build session and a structured agent question moves the build to Needs you until answered.
- The live journey must open the terminal in a new page, assert it attaches to the same build session identity, exchange harmless input, close it, and assert the build continues without an orphan PTY.
- The live journey must assert there are no dollars, budgets, spend totals, estimated build times, or duration estimates anywhere in discovery, plan, dashboard, or build detail.
- The live journey must finish with zero active builds backed by failed or abandoned jobs, zero orphan Workshop multiplexer sessions, the exact test Module purged, and Moss readiness healthy.
- Supporting API tests cover owner isolation for build messages, Build timeline reads, steering writes, question answers, cancellation, and terminal tickets. Another authenticated user receives 404 and no identifying metadata.
- Supporting terminal tests reuse the existing PTY lifecycle and ticket prior art, adding build scoping, same-session attachment, single-use tickets, disconnect behavior, and teardown on cancellation.
- Supporting job integration tests cover stale-heartbeat projection, retry-attempt projection, duplicate-start idempotency, exactly-once message delivery, restart reclaim, mid-step cancellation, and prevention of overlapping sessions.
- Supporting component tests cover the dashboard groups, purpose-built conversation, current/superseded plan card, Build timeline ordering, Needs you, stalled/retrying, failure, and terminal-unavailable states using authored design-system primitives.
- Supporting validator and installation tests continue to treat generated Modules exactly like hand-built Modules. No parallel or relaxed Workshop validator is added.
- Tests assert externally observable behavior and durable contracts rather than prompt wording, model prose, internal hook calls, or timing guesses. Model output content is not treated as deterministic; the machinery around it is.
- Prior art includes the existing live Workshop build UAT, Workshop real-data UAT, terminal PTY integration and live terminal UAT, restart-survival checks, Module validator suite, owner-isolation route tests, and pg-boss continuation tests.

## Out of Scope

- A Module marketplace, catalogue, ratings, authorship network, or external publishing service.
- Uploading generated Modules to GitHub, a registry, another Moss instance, or any external destination.
- Replacing the configured provider, capability router, multiplexer abstraction, or general Moss chat engine.
- Making the raw terminal the default or required Workshop interface.
- Opening an unrestricted generic host shell from a Workshop build. The terminal attaches to the existing build session only.
- Exposing Workshop building to additional non-admin household roles in this version.
- Allowing a build agent to edit Moss core, deployment files, unrelated Modules, or production data.
- Allowing the build agent to ship, enable, publish, or widen access to its own work without the existing human authority gate.
- Persisting or replaying the raw terminal byte stream.
- Showing percentages, generated-token counts, dollar estimates, spend, completion ETAs, or estimated build duration.
- Concurrent builds for one owner, multi-agent build swarms, or cross-user collaborative editing.
- Redesigning the generated Module’s own screens; each generated Module still requires its appropriate design and validation path.
- Solving general-purpose remote development, browser IDE, source control, pull request, or repository-management workflows inside Workshop.

## Further Notes

- This spec is a focused evolution of the approved “Moss builds modules on Moss” design. It specifically supersedes the earlier decisions that progress reaches the user only through polling/notifications, that a background job has no route into a build conversation, and that Workshop should display rough time or dollar cost.
- The recent production failure demonstrates why phase and health must be separate. A build remained labeled Building after its worker disappeared; the durable heartbeat stopped, the queue attempt remained active until timeout, and the user could not see that distinction.
- Reusing the existing terminal means reusing its proven xterm/PTY/transport pieces, not exposing the current instance-admin diagnostic shell to every Workshop build. Build-scoped attachment and owner authorization are load-bearing security requirements.
- The shortest acceptable implementation does not require a new streaming platform. Existing WebSocket/PTY transport can serve the terminal; the purpose-built UI needs a durable message/event API plus bounded polling or the project’s existing query refresh pattern. A richer push channel should be added only if measured interaction latency requires it.
- The user-facing build experience must be useful without technical vocabulary. “Writing checks,” “Waiting for your answer,” “Activity stopped,” and “Retrying” are preferred over pg-boss, PTY, heartbeat, or multiplexer terms.
- A future phase may extend Workshop to non-admin builders or collaborative builds, but that requires separate decisions about Module ownership, sharing, terminal authority, and household-wide enablement.
