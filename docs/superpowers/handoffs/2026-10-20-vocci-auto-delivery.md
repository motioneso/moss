# Vocci automatic completed-recording delivery

## Objective and authority

Ben requested a new session for automatic delivery after independent Opus review and merge of PR #3548. Your goal is completed recording on the ring → automatic Android retrieval → authenticated Moss import → configured transcription → existing Meetings history, preserving source bytes, IDs, hashes, bookmark timing and normal/voice-request mode. Begin only after confirming #3548 is merged. This handoff is not a claim that Android delivery already exists.

Own the Android delivery feature and its integration work in your fresh worktree. Other agents may be working: preserve their edits and resources. Do not perform production deployment or delete recordings/change ring ownership as part of this task.

## Start

1. Read AGENTS.md, CLAUDE.md, docs/DEVELOPMENT_STANDARDS.md and the repo plan-build skill. Search Hindsight and current code through the graph. Read the merged receiver spec, docs/vocci-recording-import.md, task #3547 and PR #3548 review/merge evidence. Install dependencies.
2. Ground yourself in the ring research at ~/app-research/apk-input-20261010-165133: analysis/1.1.24/authentication-validation.md, auth-validation-state.md, feature-validation.md and moss-onboarding-handoff.md; probe/README.md; probe/src/local/vocci/probe/RingAuth.java. The old handoff predates the completed Moss receiver; trust the merged code for that status. The research workspace is reference material, not an untracked runtime dependency for Moss.
3. Before product implementation, establish a scoped design spec and GitHub task, then a plan through plan-build. Ben has authorized the automatic-delivery objective and the existing completed-recording MVP. Record that authority accurately; do not invent approval for an unreviewed consumer onboarding design or new module. Resolve routine choices autonomously. If a material design decision remains, check Hindsight and matching project passages in ~/obsidian-vault before involving Ben. Commit and push the spec/plan before starting implementation.
4. Establish the Android client and Moss authentication seam from current code; do not impersonate an existing macOS companion. Design persistent retrieval/upload state, secure retained-key storage, retry/reconnect and interrupted-transfer handling, immutable recording identity and dedup, background/screen-off behavior, and a clean handoff from Vocci's reconnect service. The diagnostic package-disabling procedure is not a consumer handoff design.
5. Deliver one working vertical slice and exercise real ring → Android → Moss → transcript. Use isolated gates for database tests and claimed devports for servers. Preserve executable assertions and private evidence. Extend to long recordings only with an explicit transport design; the merged proof receiver accepts at most 120 seconds. Keep app-map declarations and PR release notes truthful.

## Established foundation

Independent authentication and retrieval have been validated on Timon V2.5.1 firmware 0.4.01. Normal and hold recordings and their sidecars were downloaded in fresh authenticated sessions with Vocci isolated; hashes matched, 16 kHz mono audio decoded without gaps, and the 13-second bookmark persisted. Hold files use amsg_ and signify voice requests; importing them never authorizes execution or automatic Tasks.

The existing ring binding credential was recovered through the owner's authenticated read-only Vocci bind-list flow and retained in the diagnostic probe's private files/auth.json. Check availability without printing or copying secrets into logs/docs. Do not ask Ben to sign in or recover the key again unless it is actually unavailable or invalid. Initial recovery for new users still requires Vocci account/backend access; consumer sign-in/key caching is proposed, not shipped.

Production storage must use Android Keystore protection. Preserve pairing, ownership and source files; neither a download nor a successful Moss import is permission to delete or send a destructive sync acknowledgement. If temporarily isolating the official app during authorized physical validation, restore its prior state and Bluetooth afterward.

Live streaming, iOS, fresh ownership provisioning, request execution and new consumer screens are separate scope decisions. Ring reboot resilience and background reliability remain to be tested. Finished-file delivery is the MVP.

## Completion

Report what works through the actual installed path, tests/proof, PR(s), limitations and next action. Keep local durable state under ~/.local/state/moss/vocci-delivery/auto-delivery-state.md, free only resources you claimed, and leave tracked plans/code clean and pushed. Start work now; do not end after merely acknowledging this brief.
