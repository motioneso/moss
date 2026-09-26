# Design: Google Antigravity ACP provider (#2731)

**Status:** Draft for Ben review. Not approved for implementation. UI and credential-storage decisions remain open.

**Goal:** Replace the unsupported personal-account Gemini CLI path with Google's official Antigravity ACP agent, through Moss's existing Google ACP provider row. Keep the direct Google API path available and separate.

**Grounding:** The approved [ACP client design, §9](2026-09-06-acp-client-design.md#9-providers-and-their-adapters) left Google AGY unavailable pending a proven login path. The official v1.2.1 probe and registry artifact are recorded in [issue #2731, comment 5850438649](https://github.com/motioneso/moss/issues/2731#issuecomment-5850438649). The probe ran outside Moss and completed one real personal-account chat turn.

## 1. Provider and artifact

Keep `AcpProviderKind = "google"` and complete the existing Google row in `packages/acp/src/providers.ts`; do not add a second Google provider kind or a parallel chat engine.

Pin Google's official registry entry `antigravity-acp` at **1.2.1** and its Linux x86_64 release artifact, `agy-acp-server-1.2.1-linux-x86_64.zip`. The probed archive SHA-256 is `9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843`. The registry's Linux command is `./agy_acp_server.par` with args `["--uid="]`; the archive also contains `localharness_external`. Resolve launch command and args from the pinned registry metadata rather than inventing them. Verify the artifact digest before extraction and never resolve `latest` at runtime. The verified artifact is Linux x86_64; other server architectures stay unavailable until their official artifacts are separately pinned and probed.

Launch the registry's AGY ACP server through the existing per-user CLI runner, with the provider owner's runner identity and home. The host must refuse a missing, unsupported, or digest-mismatched binary before spawning it. Do not copy Google CLI `oauth_creds.json` into AGY or assume the two CLIs share login state.

## 2. Owner-scoped sign-in

The Google connection belongs to one Moss AI-provider owner (`owner_user_id`). It is never one household-wide Google login. The ACP server runs only in that owner's isolated runner identity and home; a different owner gets a different home and cannot reuse the first owner's AGY login. Reuse the same owner's AGY home after a Moss or agent restart so AGY can resume its own login.

Sign-in uses ACP v1:

1. `initialize` negotiates protocol v1 and returns the agent's auth methods.
2. Moss accepts this adapter only when `oauth-personal` is advertised, then calls `authenticate` with that method id. Do not silently switch to `oauth-business`, `gemini-api-key`, or `agent-platform`.
3. The pinned server emits its Google OAuth URL on stderr while `authenticate` is pending. The ACP login operation captures the URL only for the requesting owner and presents it as a link in Settings. Raw stderr and the URL must not enter logs, audit metadata, prompts, job payloads, or another owner's response.
4. AGY starts its own listener on a random loopback port and handles the OAuth callback. For a headless remote server, Settings shows the callback port and the proven direct SSH local-port-forward instruction before the owner opens the sign-in link; the documented command shape is `ssh -N -L <port>:127.0.0.1:<port> <ssh-host-alias>`. Moss reports the operation's pending/success/timeout state. It never asks the user to paste a callback URL or one-time code into Moss.
5. If authentication expires or `session/new` reports `auth_required`, show the existing Google re-sign-in remediation for this owner and start a fresh ACP authentication operation.

The observed agent waits about five minutes for the callback. Show a clear timeout state with a retry action. The probe confirms AGY's token file is mode `0600` and survives a fresh agent process using the same home; it does **not** establish encryption at rest. Before enabling the row, the implementation must show how AGY's persisted credential satisfies the repository's AI-secret storage rule as well as per-owner isolation. File permissions alone are not proof of encryption.

## 3. Models and chat

There is no separate AGY model-list call. After authentication, open an ACP session and read the `configOptions` entry whose id is `model`; these values are the model catalog for that owner. Apply the selected exact model id with `session/set_config_option` before the first `session/prompt`. Refresh repeats that discovery against the current AGY session. Do not hardcode model ids or infer availability from Google API models.

The probe selected `gemini-3.6-flash-low` from AGY's advertised options and received `pong` with `end_turn` in 1.6 seconds. This is evidence for the pinned artifact, not a permanent catalog or latency promise.

If `model` is missing, empty, or no longer includes the configured id, do not prompt with an implicit fallback. Mark the Google ACP model unavailable, refresh the catalog, and ask the user to select an advertised model. Keep direct Google API models on their existing API path. Do not fall back from AGY to the Gemini CLI or an API key without the router explicitly resolving that separate provider.

## 4. Permissions and provider isolation

The existing Moss chat profile remains the policy boundary: its launch off-list, AI gateway allowlist, approval card, and audit trail apply to AGY sessions exactly as they do to other ACP agents. The Google row remains `chatReady: false` until a pinned-version check confirms AGY can run the chat profile without its own shell or file-write tools. If that cannot be verified, fail closed and do not offer Google ACP chat.

The probe observed mode names `default`, `auto_edit`, and `yolo`, but did not establish their selection schema or permission semantics. Do not expose those as Moss settings and do not infer that a name is safe. Verify the exact v1.2.1 behavior; never select `yolo` for chat. Moss tool writes and destructive actions continue through the existing policy and approval flow.

Only the Google ACP row changes. Keep the `openai` row on Codex and the existing `openai-compatible`/OpenCode mapping intact. Do not copy or share state among Google, Codex, and OpenCode homes. Direct API provider configuration, credentials, model discovery, and routing remain on their existing paths.

## 5. User-facing states and recovery

| Condition | Settings/chat message | Recovery |
| --- | --- | --- |
| Pinned agent missing or artifact digest differs | Google Antigravity is unavailable | Repair the pinned installation; never run an unverified binary |
| `oauth-personal` is absent | Google sign-in is unavailable for this agent version | Keep the provider disabled and review the pinned adapter |
| OAuth callback has not arrived before AGY times out | Google sign-in expired | Check the SSH local forward, then retry from Settings; never paste the callback URL/code |
| `session/new` requires authentication | Google is not connected for this owner | Start owner-scoped sign-in again |
| No advertised `model` option or saved id is absent | No available Google ACP model | Refresh models and select one returned by AGY |
| Chat profile cannot disable native shell/write tools | Google Antigravity is not available for chat | Keep `chatReady` false until a supported deny mechanism is verified |
| A Moss tool action is denied or not approved | Explain that the action was not performed | Follow the existing approval/policy guidance; do not retry automatically |

The build PR updates `packages/shared/src/app-map-core.ts` for the Google sign-in requirement, owner scope, new unavailable/expired states, and their remediation. Update the user-facing Assistant & AI declaration too if Ben chooses an owner self-service surface. Keep the app map aligned with whichever UI is approved.

## 6. Ben review required before UI implementation

A side-by-side illustrative mockup was attached to the `needs-ben` request. It is not a screenshot of the current product. Ben needs to choose both:

1. **Who completes Google sign-in?** The owner in their own Assistant & AI settings, or an admin-selected owner flow where the selected owner completes OAuth.
2. **What happens to Gemini CLI controls?** Retain them with a clear personal-account status, or remove them from the settings surface. Hiding a control does not delete existing installations, credentials, or settings.

No removal, migration, or reclassification of existing Gemini data is authorized by this draft. The direct Google API provider remains separate in either UI option. The callback behavior is grounded in the probe: direct SSH forwarding to AGY's loopback listener, with no pasted callback URL/code. A different callback transport needs its own evidence and must preserve the same no-paste rule.

## 7. Live proof required on the implementation PR

The official scratch probe is not Moss live-path proof. Before the provider is offered or the implementation PR merges, record these checks on the live dev instance:

- From the approved Settings surface, complete `oauth-personal` sign-in on the real Google account using the in-product link and SSH local forward; AGY must receive its own loopback callback without a pasted URL/code.
- Discover models from `session/new`, set an advertised model through `session/set_config_option`, and complete a real Moss chat turn.
- Restart Moss and start a fresh AGY process for the same owner; verify sign-in and model discovery still work.
- Use two Moss owners: prove the second cannot reuse or read the first owner's AGY state, and that no Google token or OAuth URL appears in API responses beyond the requesting owner's transient sign-in link, logs, audit, prompts, or job payloads.
- Verify the chat off-list and policy/approval behavior against the pinned server. If AGY cannot honor the existing chat permission profile, record the blocker and leave the provider unavailable.
- Verify that a Google API-key model still uses the direct API path and that Codex and OpenCode still resolve to their separate adapters and homes.

## 8. Sources

- [Issue #2731](https://github.com/motioneso/moss/issues/2731) and [official AGY v1.2.1 probe](https://github.com/motioneso/moss/issues/2731#issuecomment-5850438649).
- [Official Antigravity ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
- [Google Antigravity sign-in documentation](https://antigravity.google/docs/ide/extensions/zed/).
- Approved [ACP client design, §9](2026-09-06-acp-client-design.md#9-providers-and-their-adapters).
