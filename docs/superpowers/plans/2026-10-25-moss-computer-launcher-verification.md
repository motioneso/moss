# Computer launcher file verification

Code with no production caller. No Computer runtime, image, Docker, deployment or production
operation. `unavailableAdmission` stays the only admission. Parents #3577, #3616, #3617, #3618 and
#3619 stay open. Closes the gate the Security review of PR 3698 set on the
[launcher plan](2026-10-25-moss-computer-launcher.md): the launcher must verify the bundle file and
the node binary before the first real caller exists.

## Scope

1. Before spawning, `launchHold` verifies the node binary and the bundle file.
2. After spawning, and again after the start-up byte, it checks that the child is still that node
   binary running exactly the arguments it was given.

Out of scope: where the node, bundle and config paths and their hashes come from (installed
delivery, handover item 5), the bound second phase and first healthy sample (item 4).

## 1. Verification before spawn

New required inputs `nodeSha256` and `bundleSha256` (lowercase hex). For each file:

- The path must pass `assertTrustedPath`: absolute, normalised, no links, every ancestor root-owned
  and not group or other writable, the file a regular file with one link.
- The file is opened once with `O_NOFOLLOW`, hashed through that descriptor, and refused if the
  hash differs, the size passes a limit (node 512 MiB, bundle 16 MiB), or the device, inode, size
  or modification time changed while reading.
- Any failure throws before spawn. Nothing starts.

Residual gap. Between the check and `spawn` another process could replace the file only if it can
write a root-owned, non-writable directory, which is root. The launcher does not defend against root.

## 2. Image check after spawn

`/proc/<pid>/exe` must have the same device and inode as the verified node binary, and
`/proc/<pid>/cmdline` must equal the node path, bundle path, `hold` and config path exactly. It
runs before the byte is read and again after it, next to the existing identity check.

This catches a child that exec'd into another binary or other arguments before the second check.
It does not catch an exec that happens after the second check, and it does not prove which code
the verified node binary then runs beyond the hashed bundle argument. Node may still load files
the bundle names, and the bundle is built to import only Node builtins (PR 3698).

## Tests (each seen failing with its protection removed)

- Bundle hash differs, node hash differs, bundle edited after pinning, malformed hash: refuse, and
  `spawn` is never reached.
- Default trust check refuses a non-root-owned path; an injected rejecting check refuses.
- Image check accepts the verified binary with the given arguments; refuses another inode and
  other arguments.

## Gates

Independent Security and Standards/Spec acceptance of the exact final head. Full local gate through
the verify-gate skill. Green CI on the PR. No live proof applies: nothing user-visible exists and
there is no production caller. A real run against a root-owned install is part of installed
delivery (item 5).
