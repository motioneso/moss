# Design: Google Antigravity ACP provider (#2731)

**Status:** Approved by Ben 2026-09-28 (section 6 records his answers). Credential storage and the paste-back delivery probe remain build gates (section 2).

**Goal:** Replace the unsupported personal-account Gemini CLI path with Google's official Antigravity ACP agent, through Moss's existing Google ACP provider row. Keep the direct Google API path available and separate.

**Grounding:** The approved [ACP client design, §9](2026-09-06-acp-client-design.md#9-providers-and-their-adapters) left Google AGY unavailable pending a proven login path. The official v1.2.1 probe and registry artifact are recorded in [issue #2731, comment 5850438649](https://github.com/motioneso/moss/issues/2731#issuecomment-5850438649). The probe ran outside Moss and completed one real personal-account chat turn.

## 1. Provider and artifact

Keep `AcpProviderKind = "google"` and complete the existing Google row in `packages/acp/src/providers.ts`; do not add a second Google provider kind or a parallel chat engine.

Pin Google's official registry entry `antigravity-acp` at **1.2.1** and its Linux x86_64 release artifact, `agy-acp-server-1.2.1-linux-x86_64.zip`. The probed archive SHA-256 is `9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843`. The registry's Linux command is `./agy_acp_server.par` with args `["--uid="]`; the archive also contains `localharness_external`. Resolve launch command and args from the pinned registry metadata rather than inventing them. Verify the artifact digest before extraction and never resolve `latest` at runtime. The verified artifact is Linux x86_64; other server architectures stay unavailable until their official artifacts are separately pinned and probed.

Launch the registry's AGY ACP server through the existing per-user CLI runner, with the same runner identity and home model the Claude and Codex providers use. The host must refuse a missing, unsupported, or digest-mismatched binary before spawning it. Do not copy Google CLI `oauth_creds.json` into AGY or assume the two CLIs share login state.

## 2. Admin sign-in, inherited by the household

Google works like every other CLI provider. The admin adds the Google provider in the AI provider settings and completes the Google sign-in once. Every household member inherits that provider and uses it through the router, exactly as they inherit Claude and Codex. This matches the approved [ACP client design, section 3](2026-09-06-acp-client-design.md): one subscription login per provider, shared by the household. There is no per-member Google sign-in and no admin step that picks whose Google account to connect.

The ACP server runs in the provider's runner identity and home. Reuse that home after a Moss or agent restart so AGY can resume its own login.

Sign-in uses ACP v1:

1. `initialize` negotiates protocol v1 and returns the agent's auth methods.
2. Moss accepts this adapter only when `oauth-personal` is advertised, then calls `authenticate` with that method id. Do not silently switch to `oauth-business`, `gemini-api-key`, or `agent-platform`.
3. The pinned server emits its Google OAuth URL on stderr while `authenticate` is pending. The ACP login operation captures the URL only for the admin running the sign-in and presents it as a link in the AI provider settings. Raw stderr and the URL must not enter logs, audit metadata, prompts, job payloads, or any other user's response.
4. AGY starts its own listener on a random loopback port and handles the OAuth callback. Sign-in works the way Claude's does today: the admin opens the link, signs in with Google, and pastes something back into Moss. After sign-in, Google redirects the admin's browser to AGY's loopback address, which fails to load on the admin's own machine. The admin copies the full address from the browser's address bar and pastes it into the AI provider settings. Moss, running on the server, delivers that request to AGY's loopback listener itself. Settings tells the admin in plain words that the page will fail to load and that this is expected.
   - Moss reads the expected callback host, port and path from the `redirect_uri` in the OAuth URL it captured for this operation.
   - Moss accepts a pasted address only when it is `http`, its host is `127.0.0.1` or `localhost`, and its port and path match that `redirect_uri`. Anything else is rejected without being sent anywhere.
   - Only the admin who started the operation can submit, and only while the operation is pending. One accepted submission ends the paste step.
   - Moss sends one GET to `127.0.0.1:<port>` from inside the runner identity and never follows a redirect.
   - The pasted address carries a one-time sign-in code. It is a secret in transit. It must not enter logs, audit metadata, prompts, job payloads, stored rows, or any response.
   - Moss reports the operation's pending/success/timeout state from AGY's `authenticate` result, not from the listener's HTTP reply.
   - **Build gate:** paste-back is unproven. Before building it, a probe against the pinned v1.2.1 server must show that AGY accepts the callback when Moss delivers it on the server, and that the sign-in then completes. If the probe fails, keep the flow closed and bring the SSH local-port-forward alternative (`ssh -N -L <port>:127.0.0.1:<port> <ssh-host-alias>`) back to Ben as a fallback. Do not ship both.
5. If authentication expires or `session/new` reports `auth_required`, show the existing provider re-sign-in remediation to admins and start a fresh ACP authentication operation. Members see that Google is unavailable and that an admin must sign in again.

The observed agent waits about five minutes for the callback. Show a clear timeout state with a retry action. The probe confirms AGY's token file is mode `0600` and survives a fresh agent process using the same home; it does **not** establish encryption at rest. Before enabling the row, the implementation must show how AGY's persisted credential satisfies the repository's AI-secret storage rule and stays out of non-admin members' reach. File permissions alone are not proof of encryption.

## 3. Models and chat

There is no separate AGY model-list call. After authentication, open an ACP session and read the `configOptions` entry whose id is `model`; these values are the model catalog for the provider. Apply the selected exact model id with `session/set_config_option` before the first `session/prompt`. Refresh repeats that discovery against the current AGY session. Do not hardcode model ids or infer availability from Google API models.

The probe selected `gemini-3.6-flash-low` from AGY's advertised options and received `pong` with `end_turn` in 1.6 seconds. This is evidence for the pinned artifact, not a permanent catalog or latency promise.

If `model` is missing, empty, or no longer includes the configured id, do not prompt with an implicit fallback. Mark the Google ACP model unavailable, refresh the catalog, and ask the user to select an advertised model. Keep direct Google API models on their existing API path. Do not fall back from AGY to the Gemini CLI or an API key without the router explicitly resolving that separate provider.

## 4. Permissions and provider isolation

The existing Moss chat profile remains the policy boundary: its launch off-list, AI gateway allowlist, approval card, and audit trail apply to AGY sessions exactly as they do to other ACP agents. The Google row remains `chatReady: false` until a pinned-version check confirms AGY can run the chat profile without its own shell or file-write tools. If that cannot be verified, fail closed and do not offer Google ACP chat.

The probe observed mode names `default`, `auto_edit`, and `yolo`, but did not establish their selection schema or permission semantics. Do not expose those as Moss settings and do not infer that a name is safe. Verify the exact v1.2.1 behavior; never select `yolo` for chat. Moss tool writes and destructive actions continue through the existing policy and approval flow.

Only the Google ACP row changes. Keep the `openai` row on Codex and the existing `openai-compatible`/OpenCode mapping intact. Do not copy or share state among Google, Codex, and OpenCode homes. Direct API provider configuration, credentials, model discovery, and routing remain on their existing paths.

## 5. User-facing states and recovery

| Condition                                            | Settings/chat message                                | Recovery                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Pinned agent missing or artifact digest differs      | Google Antigravity is unavailable                    | Repair the pinned installation; never run an unverified binary                                |
| `oauth-personal` is absent                           | Google sign-in is unavailable for this agent version | Keep the provider disabled and review the pinned adapter                                      |
| OAuth callback has not arrived before AGY times out  | Google sign-in expired                               | Retry from Settings and paste the new address; an address from an earlier attempt is rejected |
| `session/new` requires authentication                | Google is not connected                              | Admin signs in to Google again from the AI provider settings                                  |
| No advertised `model` option or saved id is absent   | No available Google ACP model                        | Refresh models and select one returned by AGY                                                 |
| Chat profile cannot disable native shell/write tools | Google Antigravity is not available for chat         | Keep `chatReady` false until a supported deny mechanism is verified                           |
| A Moss tool action is denied or not approved         | Explain that the action was not performed            | Follow the existing approval/policy guidance; do not retry automatically                      |

The build PR updates `packages/shared/src/app-map-core.ts` for the Google sign-in requirement, the admin-only sign-in, the removal of the Gemini CLI controls, the new unavailable/expired states, and their remediation.

## 6. Ben's decisions (2026-09-28)

1. **Who completes Google sign-in?** The admin, when adding the Google provider, the same way every other provider works. Members inherit it. Neither per-member sign-in nor an admin-picks-an-account flow is built.
2. **What happens to Gemini CLI controls?** Remove them from the settings surface. Removing the controls does not delete existing installations, credentials, or settings.

No removal, migration, or reclassification of existing Gemini data is authorized. The direct Google API provider remains separate.

3. **How does the admin finish sign-in on a headless server?** The admin copies the failed redirect address and pastes it into Moss, the same copy-and-paste step Claude uses. No SSH tunnel. Ben's ruling in the 2731 thread: "If we can have it generate the link and the user copies it and pastes back in that would be great."

## 7. Live proof required on the implementation PR

The official scratch probe is not Moss live-path proof. Before the provider is offered or the implementation PR merges, record these checks on the live dev instance:

- As the admin, from the AI provider settings, complete `oauth-personal` sign-in on the real Google account using the in-product link and a pasted redirect address, from a browser on a different machine than the server, with no SSH tunnel.
- Paste a wrong-host, wrong-port, and already-used address; each must be rejected without any request reaching AGY. Confirm the pasted address does not appear in logs, audit, or API responses.
- Discover models from `session/new`, set an advertised model through `session/set_config_option`, and complete a real Moss chat turn.
- Restart Moss and start a fresh AGY process; verify sign-in and model discovery still work.
- Sign in as a non-admin member: prove the member can chat through the inherited Google provider, cannot start or see the Google sign-in, and that no Google token or OAuth URL appears in API responses beyond the admin's transient sign-in link, logs, audit, prompts, or job payloads.
- Verify the Gemini CLI controls are gone from the settings surface and that existing Gemini installations and settings are untouched.
- Verify the chat off-list and policy/approval behavior against the pinned server. If AGY cannot honor the existing chat permission profile, record the blocker and leave the provider unavailable.
- Verify that a Google API-key model still uses the direct API path and that Codex and OpenCode still resolve to their separate adapters and homes.

## 8. Sources

- [Issue #2731](https://github.com/motioneso/moss/issues/2731) and [official AGY v1.2.1 probe](https://github.com/motioneso/moss/issues/2731#issuecomment-5850438649).
- [Official Antigravity ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
- [Google Antigravity sign-in documentation](https://antigravity.google/docs/ide/extensions/zed/).
- Approved [ACP client design, §9](2026-09-06-acp-client-design.md#9-providers-and-their-adapters).
