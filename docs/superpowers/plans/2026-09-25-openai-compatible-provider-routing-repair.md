# Plan: Explicit OpenAI-compatible provider routing repair

**Date:** 2026-09-25
**Decision:** Ben's routing rulings in chat, 2026-09-25
**Existing design:** `docs/superpowers/specs/2026-09-06-acp-client-design.md` and
`docs/superpowers/plans/2026-09-07-acp-slice1-chat.md`; this repair amends their earlier
provider-kind-only routing rule.

## Goal

Route each CLI provider through its configured ACP agent identity. API-key providers must never be
misrouted through a CLI agent; live chat rejects them before engine launch until tool and
confirmation parity is implemented. Codex and OpenCode remain available, and OpenCode appears only
after an admin adds it.

## Decisions and compatibility

- Keep `AiProviderKind` as the model/API protocol family. Do not use `openai-compatible` to infer a
  CLI agent.
- Persist an opaque CLI agent identifier on provider configuration. API-key configurations have
  no CLI agent identifier. The identifier is compatible with a future ACP registry entry ID; this
  repair keeps the current agents and current static registry intact.
- The current catalog/login path created every `openai-compatible` CLI configuration as Codex.
  Backfill those existing CLI rows to the Codex agent. API-key rows stay on API routing. Never
  infer OpenCode from `openCodeModel`, a model name, or a display label.
- Add OpenCode as an explicit provider choice. Remove the unconditional OpenCode card and note;
  show its model setting only when an OpenCode agent configuration exists. Launch OpenCode only
  when the selected model belongs to that configuration.
- Remove the provider-level Interactive/Non-interactive setting from admin UI/API/DTO and stop
  threading it through provider config into live chat. Keep the internal execution strategies still
  used by non-ACP module-build and structured callers until those callers migrate.
- Keep ACP authentication, terminal login, permission prompts, model-setting, and self-heal/retry
  behavior. A retry must retain the same selected provider identity and must not fall across CLI
  agents.
- Full ACP registry ingestion is a separate follow-up issue/spec. Its boundary is registry source
  trust and refresh, stable registry IDs, installation and launch resolution, and verified
  authentication/permission/tool compatibility. This incident does not build a marketplace or
  replace current integrations.

## Implementation tasks

1. Add persisted CLI agent identity to provider config DTO/schema/repository and create/update
   routes. Add a forward-only AI module migration and a narrow legacy backfill for existing
   `openai-compatible` CLI rows to Codex. Ensure API-key providers have no CLI identity.
2. Expose explicit CLI choices in provider administration, including OpenCode, and preserve the
   chosen identity when authentication/configuration is updated. Key CLI availability, health
   checks, auto-registration, and model discovery to the chosen agent identity. Remove the
   provider-level execution-mode control and its provider-configuration DTO/API branch.
3. Carry the selected provider configuration and identity through chat resolution, session launch,
   cli-runner RPC, and retry/self-heal. Reject API-key rows before engine creation with an explicit
   unavailable error. Route CLI rows through only their persisted ACP agent. Retain ACP
   authentication and permission handling.
4. Remove the unconditional OpenCode settings card and explanatory note. Gate the saved OpenCode
   model setting on an added OpenCode provider and apply it only when that provider's model is
   selected. A stale setting never creates or selects a provider.
5. Update Moss's app map and this plan where shipped behavior differs.

## Verification

- API-key live chat reports that it is unavailable before creating a conversation or engine; it
  never launches a CLI or silently falls back to a different provider.
- A migrated legacy OpenAI-compatible CLI config launches Codex. A configured OpenCode provider
  launches OpenCode only when its model is selected. There is no cross-agent fallback.
- Creating or logging in to Codex cannot discover or auto-register models on OpenCode, and
  OpenCode cannot inherit Codex's discovered model list.
- With no OpenCode provider, the card/model option/note are absent, including when stored
  `openCodeModel` is present. After explicitly adding OpenCode, its model control appears.
- Anthropic and Google routes remain unchanged. ACP authentication, permissions, replay, and
  retry/self-heal preserve the selected agent.
- Provider-config API/UI no longer exposes Interactive/Non-interactive. Existing non-ACP
  consumers retain their required internal execution strategy.
- Run scoped package/type/test checks. Record live UI evidence before merge under the live-path
  gate; do not deploy from this task.

## Follow-up spec boundary

API-key live chat parity is a separate follow-up. It must cover streaming, MCP tool calls,
permission and confirmation handling, cancellation and retry behavior, and route/auth tests before
API-key providers can be enabled for chat.

The registry follow-up will read public registry records and distribution metadata, pin/refresh
them under an explicit trust policy, validate each agent's authentication and permission
capabilities, and offer agents only as explicit admin additions. Its stable registry ID feeds the
persisted CLI agent identity introduced here. It will not change the API-key provider path or
silently substitute an agent for an existing Codex/OpenCode connection.
