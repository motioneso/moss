# Moss Computer spec/plan: independent review

- **Candidate:** the exact spec, plan and qualification evidence in this documentation branch.
- **Reviewer:** `/root/independent_review`, independent of author Codex `/root`.
- **Current status:** static candidate accepted; runtime evidence partial, recovery gate FAIL. Final exact-report review follows below. Historical documentation-only review is preserved.

The reviewer must check authority, product destination, source/installed identity separation, private viewing and egress gates, resource/storage limits, named finish controls, manual versus automated acceptance, actual-replacement requirements, shared ownership, stop boundaries, and evidence honesty. Record exact document hashes or commit, verdict and material findings here. Do not convert documentation acceptance into runtime acceptance.

## Round 1

Independent reviewer found one missing guardrail: the plan needed to prohibit disabling container security profiles or the browser sandbox to make the image work. It also requested that the proposed next assignment explicitly include enforced egress combined with viewing. Both findings are retained and corrected in the spec, plan and evidence report.

The reviewer otherwise found the product direction, automated/manual distinction, source/installed identity separation and `NOT_RUN` classifications sound. Overnight authorisation does not override failed launch gates.

Reviewed SHA-256 before correction:

| Document | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| Spec     | `0fb9836ed94f2ab65a8e6e74520f66ce62e23fc6c696861734f20d17f08184d5` |
| Plan     | `ade0784deca38fcea86fd6053a4b03591c46cfbc7f0097e39968b885a3a92c3d` |
| Evidence | `44654dfa09da8733d5ca004884dc1eeb5148b7bc0f20c513838d79f220fca337` |

## Correction review: accepted

Reviewer verdict: “PASS — corrected documents accepted. Both review findings are resolved. No remaining blocking document findings.” This accepts the spec, plan and readiness report, not runtime suitability. No proof should start while entry gates remain unknown.

Accepted SHA-256:

| Document | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| Spec     | `dcec5bc44df45652e78197a208cad358e1ada3ddb784ebb68f957fd450a85f3e` |
| Plan     | `1364a70f10732a7027b075aaf3f6c4bf9f6ffdb4208fda32e18e0459923c132d` |
| Evidence | `bf24e1bea1888c8c64c9a53a09e95c6b4b45004280aa5c11eed72beee72143dd` |

## Historical documentation-only closure at commit83ec63b2a

The three accepted documents were preserved unchanged at that checkpoint after correction review. Later implementation amendments are reviewed separately below. Scoped Prettier and relative-link/private-content checks passed. No database, product UAT or full foundation gate ran for this docs/preflight change.

At closure, `docker ps -a --filter name=moss-computer-qualification` returned no containers. Production `moss` was running and healthy. No image was pulled, proof runtime launched, port reserved or data volume created; there is no unattended job to finish. The task and parent remain open. The isolated documentation worktree is committed/pushed separately without modifying the original shared checkout or merging.

## Autonomous implementation: first candidate review

Ben subsequently authorised autonomous implementation. Reviewer independently accepted commit `1f110888f2a6801554cd325d2de8d6db22aca243` for one actively supervised offline qualification, using image `sha256:95edd6e239f22851b46c0748090d1ddebba50b2eae5223698b6c0a80a65b0c30`. This is launch-readiness approval, not runtime acceptance.

Material prelaunch findings corrected: fixed Compose name could collide; monitor omitted writable socket directory; Nginx temp paths could target the read-only root; receipt writes could prevent fail-closed stopping; fallback run ID and stop-failure reporting needed to be explicit. Exact corrected supervisor hash: `95abc5d8161c9c15d8b1666d1156549b688cf05b6ff3038ffe37c51b0284ffd9`.

Runtime exposed an installed dependency mismatch and missing published listener. Reviewer accepted the bounded correction direction (pinned Websockify 0.13 wheel, normal bridge only for trusted gateway) pending exact-file review. No browser or persistence acceptance followed the failed launch.

## Final independent review: partial evidence accepted, recovery gate FAIL

Reviewer `/root/independent_review2` did not author the candidate or evidence. It independently
reviewed raw receipts and the final exact files. Verdict: **PASS for report accuracy and static
candidate; recovery gate FAIL.** No blocking inaccurate claim remained. Full product acceptance
and merge readiness do not follow.

Accepted covered cases: substantive framebuffer and keyboard input, actual browser sandbox
inspection with unavailable user namespaces disclosed, real replacement/file/profile/bookmark
survival, observed failing security negative controls and fail-closed stopping. Crash transport
reconnect passed before recovered rendering timed out; recovered input was not reached. Cause is
unknown. The reviewer accepted one focused recovery qualification before owner integration.

The reviewer independently confirmed source hashes against the receipt, shell syntax/whitespace,
absence of proof containers/network/listener5180, removed ephemeral keys, retained home and healthy
Moss. Full foundation/Moss live-UI/platform gates did not run for this internal candidate.

| Exact reviewed artifact | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Evidence ledger         | `f42c34d9fdfcf29b8b7aeca9302ee7a4dc8935f7fea6d781224b84058540bdb5` |
| Runtime receipt         | `ebfb7e4fd6894b4bac59d173f2b888ca2b92293f14dde08cab67c2a881e88388` |
| Spec                    | `d9b671fcf45f9810896cb449c2cd0fb56ec274af0d4dafd5e3bffdb4b3b4896a` |
| Qualification plan      | `f7ef806710d44a39cc3e51ad434db0eefa9d32d5c38da96d57d96063ff4e21b8` |
| Proposed recovery plan  | `d61653771562c9d6e7584af61931e309ad94da5e16126d89bce9d7faf2c5c662` |

## Recovery dispatch: missing candidate, reviewed preflight

Ben dispatched the recovery packet with “proceed”. Before runtime, Docker reported the exact
previous image absent. Reviewer `/root/independent_review2` independently checked the final
report, receipt and packet and returned **PASS; no blocking findings** for report accuracy and
the bounded reconstruction proposal. Recovery remains **NOT_RUN / BLOCKED_MISSING_PINNED_CANDIDATE**.

The reviewer confirmed the image is absent, source hashes unchanged, retained marker present,
no proof containers/listener5180, released port reservation and healthy Moss. No runtime acceptance
transfers to a rebuild. The next proposal reconstructs and independently adopts/rejects one exact
candidate, stopping before recovery runtime; it has not started.

| Exact reviewed artifact          | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| Recovery preflight report        | `c7239714a7511cdbc6c04df2ee2fb8a73e7f7287b43bab5661e2d2b9950eaefd` |
| Recovery preflight JSON          | `824512498af32a6b1c7cb9c2501a22f6f76d8899a80afd6d33cb12f34b3e0098` |
| Dispatched/blocked recovery plan | `43c37819ca66608fe927ffe32a848bfdd970915ffeb80e25256be76e24ea4c64` |

## Reconstruction checkpoint: adopt for later recovery trial

Ben dispatched the proposed reconstruction checkpoint. Reviewer `/root/independent_review2`
independently accepted staged build readiness, conditional on the actual resource/cancellation
probe. That probe passed before the candidate build. Exact readiness hashes:

| Artifact              | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Reconstruction plan   | `bc82b637a8c6d7e8e37177105b36a5ceabadfafb0bf40b46a5cc26a22e96f57e` |
| Run-scoped supervisor | `735d959829e24a2484eec3f9835706a0caf2a59831d320dac09a5d09c6d6b780` |
| Derived Dockerfile    | `a55c342c055e6eaaf6feba9ec5805d82ee20e113eda0ec457b3d20dcda231765` |
| Diagnostic Dockerfile | `2db0cee911f9b6b10bef0427eb9d313e33626617a5b514da5a104e57f1848575` |

Final independent verdict: **PASS — ADOPT_FOR_LATER_RECOVERY_TRIAL**, exact candidate
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
No blocking report inaccuracies. Reviewer independently checked package inventory equality,
actual image configuration and packaged source, probe limits/cancellation, archive checksum/config
identity/layer list, final image existence, no checkpoint containers and healthy Moss.

| Exact reviewed report   | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Reconstruction Markdown | `67986be966f9b3eb350598ec57d0578f5d6521957a94e481bdd3aa03626d79cb` |
| Reconstruction JSON     | `9c7f2b07284e03af63015e24861fe99e084f56894d74a14b7a7b2048f7ab9459` |

This accepts the reconstructed artifact for a later trial, granting no desktop, recovery,
persistence or security acceptance for it. Earlier recovery failure and original image loss remain
unexplained. The proposed next step independently reviews an amended recovery packet before
runtime; this checkpoint stops here. No merge readiness or guide progress follows.
