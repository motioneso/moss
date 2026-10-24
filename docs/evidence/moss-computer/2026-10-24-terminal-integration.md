# Root observer to receiving lifetime IPC

Part of #3618/#3617/#3616/#3577. Base `6da85fff63ab4e0144bab49caa99086934ee004a`
(actual PR #3647 merge); accepted amended contract
`0902fcef059a9693764a99591ea923c2f851c2c0`.
[Machine-readable receipts](2026-10-24-terminal-integration.json) identify the exact source,
commands, exits, artifact/source/patch/log hashes and every retained review round.
Final source: `3a8eafe969505d8ef9975ee6e4e17f407d8ce16b`.

## Result and boundary

An opt-in root observer and gateway now exchange a bounded authenticated lifetime over a dedicated
private Unix endpoint for existing exact resources. Root publication follows durable first healthy
sampling and post-await policy/freshness checks. HMAC transcripts bind exact run/instance/resource
generations and IDs, message type, fresh root/session/challenge/stop nonces and sequential counters.
API access requires activation. Lost/replaced/replayed/expired lifetime retires the receiving core.
Actual input/post-auth/frame dispatch checks absolute receiver expiry independently of timer delivery;
equality expires. Startup loss destroys late guest/core completions before API admission.

Root terminal entry starts stop delivery independently of journal persistence and collector exit.
Receiver invokes synchronous core.close/epoch retirement before writing its signed fenced ack;
asynchronous cleanup may still be outstanding. Acknowledgement establishes invoked retirement,
not successful pressed-release delivery, finished transport cleanup or independent Computer closure.
Root retains one absolute five-second finalization deadline and all inherited acknowledgements.

This remains internal existing-resource tooling. Normal API/host deployment and unavailableAdmission
are unchanged. No product capability, setting, UI or app-map entry is added. Normal disable/recreate,
daemon/root lifecycle mutation, config provisioning, new-run/reset and uncertain-create quiescence,
independent Computer closure, installed runtime and ordinary owner delivery remain work. Parent
issues #3577/#3616/#3617/#3618/#3619 remain open. Accepted r21 persistence is reused; r12/r18 causes
remain unknown. No production deployment occurred.

## Checks and disclosed fixtures

The final restored batch and exact source hashes are in JSON. The focused behavior set covers
480 tests across 24 files, including native Unix sockets and a separately executed actual root
supervisor driving the actual gateway/core. It exercises active owner input, watcher frames,
pressed releases, held journal and asynchronous cleanup, root death/hang, duplicate lifetime,
independent API socket capacity, startup loss/late completion and expiry before delayed timers.
Root/tests TypeScript, scoped ESLint zero warnings, changed-file Prettier, file-size, whitespace,
builtin-only observer bundle and gateway build are required; JSON records their actual exits.

Synthetic auth/readiness/Docker/root-ownership/namespace and library Fence fixtures are explicitly
disclosed. They do not establish installed root trust, actual live health/inventory, TigerVNC,
image/Node24/128MiB fit, owner HTTPS/WSS/chat or independent resource closure. Build target is
Node24 metadata; native execution used Node22. No image/runtime/Docker operation, DB/foundation
command, TCP server, browser, installation or production action occurred. Tests close their owned
native processes/sockets/temporary files; raw fixture IDs/configuration remain private.

## Observed protection-removal controls

Each final control exited1 at an intended assertion, with exact production bytes restored.

| Removed protection               | Intended assertion failure                                         |
| -------------------------------- | ------------------------------------------------------------------ |
| HMAC comparison                  | Forged/binding-invalid proof activated; forged fenced ack accepted |
| Root nonce binding               | Root sent an alive response to a replayed challenge                |
| Stop nonce match                 | Forged fenced nonce returned success                               |
| Receiver message expiry          | Equality-late alive response activated                             |
| Root message expiry              | Equality-late challenge received an alive response                 |
| Actual dispatch lifetime expiry  | New key/pixel sent, including held post-auth input                 |
| Pre-ack synchronous retirement   | Core was not closed when the signed fenced ack was written         |
| Four-frame event budget          | Fifth frame reached dispatch                                       |
| Actual outgoing backlog budget   | Send failed to reject                                              |
| Partial-line absolute expiry     | Equality-late partial frame reached dispatch                       |
| Absolute startup expiry          | Late guest completion resolved                                     |
| First sample durability ordering | Lifetime published before journal completion                       |
| Post-persistence sample age      | Equality-old sample published a lifetime                           |
| Stop-marker refusal              | Terminal observation resolved                                      |

Initial root-replay removal exited0: later protocol failure masked the missing nonce check.
The strengthened test directly asserts no alive response. Initial frame/partial controls failed
by test timeout and are not accepted sensitivity proof; direct dispatch assertions now fail at
the intended point before cleanup. The first retirement control removed both retirement calls;
the final control removes only pre-ack retirement and observes core state at acknowledgement write.
The surgical pre-ack control ran on `136a4c7da`; the final test-only bound-method spelling
preserves the same actual core/observation and is rerun in the final green batch. Production file
hashes match every accepted control. All failed attempts, patches, logs and restoration hashes
are retained outside ~/Jarv1s.

## Review ledger

PlanR1 required fresh root nonce, absolute root initial/idle deadlines, a separate lifetime slot
and terminal-marker observation refusal. Exact amended planR2 received independent Spec/security
acceptance before implementation. SourceR1 required a canonical field validator instead of a
copy, actual dispatch expiry checks instead of timer-only retirement, and startup late-completion
coverage. Corrected production source `b30d3be7d59c8c184b5f628e8acb5defa0ff381b` received
independent source acceptance; later commits only strengthen tests/type annotations.

### Standards

Independent Standards review accepts the exact source identified in JSON, with no remaining
structural finding. R1's duplicated helper moved to builtin-only host-contract with compatibility
reexport. Every round remains hashed; source review does not certify author execution.

### Spec

Independent Spec review accepts the exact source identified in JSON, with no remaining Spec
finding. The previously missing dispatch-expiry and startup-loss regressions are present.
Independent security review separately accepts that source. Source acceptance, final local
execution evidence and exact final CI are distinct gates.

The first final behavior batch passed480, but root TypeScript found an untyped test spy. The
explicit-this/captured-core correction and strengthened sensitivity assertions are test-only.
Earlier native fixture-loader/auth timing, legacy startup config, TypeScript/format attempts and
all superseded check batches remain private and hashed. An intermediate restored batch passed
behavior and both TypeScript checks, but lint rejected the test’s this alias. The final bound-snapshot
method correction preserves when and which core is sampled. Only final restored receipts count.

Independent exact final local evidence acceptance and exact final PR HEAD required green CI plus
supplemental acceptance are recorded on the PR before protected actual merge. Later docs-only
commits require their own format/whitespace/source-equality checks and exact CI. No runtime or
owner-delivery acceptance follows from this internal prerequisite.

The [successor dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-host-terminal-integration.md)
continues real lifecycle/root integration and independently verified closure, followed by actual
image/Node24/128MiB/TigerVNC and ordinary owner HTTPS/WSS/chat. It carries every inherited
runtime/resource/health/auth/closure gate and the authorized review→fix→exact checks/evidence/CI→
protected merge→verified fresh isolated successor chain until actual owner delivery finishes.
