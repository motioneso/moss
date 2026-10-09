# #3191 provider-restore diagnosis — WIP

Stopped at the user's request. This work is **unreviewed and unverified**. The original assembled provider-restore timeout remains unresolved; this branch must not be integrated as a certified fix.

The investigation starts from local integration `02b3103087a72b9baa5ff3f9e72e1c6989c2bbf4` in `~/Jarv1s-scheduled-provider-restore-diagnosis`. The prior assembled run completed the seed and disabled-provider draft assertions, then timed out waiting 120 seconds for the restored continuation response. It did not establish whether that final request was admitted.

## Observations and preserved correction

One passive diagnostic run reused the exact failed runtime image, `sha256:7e8917b27a4fcf0bb8bf4e82a6018448e7ab50bd41d048e0467bac48a6bbf5f9`, with the real installed Finance package and configured economy provider. Send and the message box were enabled at Enter; the restored POST was observed and returned 200 after approximately 5.5 seconds. The full durable Main assertions passed. Host instrumentation changed after the gate captured its input fingerprint, so this run is **diagnostic only**, not certification of a clean source pin or evidence that the original failure was fixed. Both harness versions and hashes are retained privately.

A controlled unit check exercised the real `useChatStream` → selection-pending → `ChatDrawer`/Composer chain, matching AppShell's mapping, with only the public history-read response deferred. A recovered Main draft was visible while Send remained disabled. Enter emitted no turn: the naive expectation of one send failed (1 failed, 14 skipped; 2.93 seconds). After resolving history and waiting for public Send readiness, the check passed with one exact recovered-draft send (1 passed, 14 skipped; 1.91 seconds). This establishes that public readiness prerequisite under controlled hydration. It does **not** establish the earlier timeout's cause.

The preserved UAT correction waits for the public Send button to become enabled before both manual sends. The restored send also passively asserts POST admission within 10 seconds, alongside the unchanged 120-second response deadline. The real provider transition, Finance caller, draft edit/clear/reload and durable Main assertions remain. No product source or app-map declaration changed; no live response was intercepted or rewritten.

## Remaining work

The applied UAT correction has not been exercised against the installed real provider. Full affected units, static/type checks and independent Standards/Spec reviews have not run on this candidate. The controlled checks are scoped observations, not branch-wide verification. Temporary debug instrumentation is absent from the preserved source.

Resume by reviewing the WIP test changes and their fixtures, then pin clean source and run the required checks and original installed Finance/provider scenario through `verify-gate`. Preserve the earlier failure and both diagnostic harness fingerprints. Further failure diagnosis must distinguish readiness, actual request/response and provider execution; a later pass alone cannot establish causality.

All owned disposable-stack containers, volumes and networks are absent. The owned port was released; the coordinator's stopped failed-image reservation remains untouched. No merge, deployment, publication, issue closure or PR readiness is claimed. #3192 and #3193 remain separate.
