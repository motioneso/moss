# Rust server/app slice 15 checkpoint plan

Part of https://github.com/motioneso/moss/issues/4027. JS-154 / Card 562. Category: N/A.

1. Extend unsigned Linux staging with an explicit native desktop resource payload. The build
   host's release WebKit uses compiled-in absolute helper paths, so preserve those paths in a
   target-root payload rather than claim a relocatable desktop bundle. Include helper ELF
   dependencies, the injected bundle, GIO TLS module, schemas, MIME data and basic fonts.
2. Exercise startup from the staged bundle in a scratch root with no host library mounts;
   preserve sandboxing and report any target prerequisites or qualification blockers honestly.
3. If startup is qualified, exercise desktop autostart and This computer through the native UI.
4. Run packaging and relevant project checks, record independent read-only review, publish real
   proof, and push a checkpoint PR. Report all remaining work in order.

Reminders and Windows supervisor assembly follow the Linux qualification work and are not
promised in this context window. No dependency installation or platform verifier is authorized.
Proof and toolchain scratch files stay outside the worktree under the task's own scratch folder.
