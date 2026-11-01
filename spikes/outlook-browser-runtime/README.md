# Outlook browser runtime feasibility proof

Synthetic experiment for [task #3570](https://github.com/motioneso/moss/issues/3570), after Ben's
2026-10-22 approval of the setup flow and disconnect semantics. **Not an installable Moss service.**
Never point this code at a real account. Its sessions are in-memory fixtures, not Moss authentication.

## Reproduce on a Linux host

Requires rootless Podman, Python 3, and the host default `/usr/share/containers/seccomp.json`.
The image contains its own Chromium, Python and websocket-client. No host browser/profile is mounted.
Run from `~/Jarv1s`:

```sh
podman build -t localhost/moss-outlook-runtime-spike:local \
  -f spikes/outlook-browser-runtime/Containerfile spikes/outlook-browser-runtime
devports claim outlook-runtime-spike
# Substitute the port printed by devports:
python3 spikes/outlook-browser-runtime/verify.py --port <reserved-port>
devports release <reserved-port>
```

The verifier creates uniquely named rootless containers/volumes, binds a loopback-only test broker
on the reserved port, and removes them in `finally`. The containers have no external network.
No production services, browser sessions, databases or deployment files are used.
After an interrupted verifier, identify only resources with the `moss-outlook-spike-` prefix and
remove those containers before their volumes. Never prune unrelated resources.

## Observed result — 2026-10-22

`verify.py` passed **17 checks** with actual Chromium containers and an HTTP frame/input broker:

- Independent persistent localStorage on the same synthetic origin; distinct PID/mount/network
  namespaces; read-only root; no published ports, host bind mounts, effective capabilities or egress.
- Chromium's `chrome://sandbox` diagnostics reported Namespace, PID/network namespaces, seccomp-BPF,
  and adequate sandboxing. The same assertion failed with `--no-sandbox` in a separate negative-control
  container, which was then removed.
- A valid synthetic session received a JPEG from its actual browser and typed into that browser's
  focused field. The other browser's field stayed empty. A second controller was refused.
- Missing sessions, invented viewer IDs and oversized input were refused. Other-user/admin ownership,
  Origin, expired/revoked session, generation, active connection, viewer lease and session binding
  denials each had an observed protection-removed negative control.
- The original marker survived graceful browser/container restart. Disconnect refused further
  frame access and removed the container and persistent volume.

The host default seccomp policy initially blocked Chromium's nested sandbox `chroot` operation.
The working experiment preserved that default policy except its capability-conditional `chroot`
rules, replacing those with a syscall allow rule. Kernel capability enforcement still applies;
the container was given no capabilities. Do not substitute an unconfined seccomp policy or disable
Chromium's sandbox in a real implementation. The explicit no-sandbox path exists only for the
negative control in this experiment.

An initial `/proc`-based sandbox probe could not establish the nested sandbox state. The final
assertions use Chromium's own diagnostics and the no-sandbox negative control rather than claiming
that observing the outer container's seccomp state proves Chromium's inner sandbox.

## Boundaries of this evidence

This is feasibility evidence, not feature acceptance or a security audit. In particular:

- Sessions and the admin principal are injected test fixtures. Real Moss auth, RLS, session
  revocation delivery and connector ownership are not wired or tested here.
- Frame delivery uses separate HTTP requests and checks each request. There is no WebSocket stream,
  browser viewer UI, MFA, mouse/keyboard/IME coverage, TLS or remote-phone acceptance.
- It does not exercise Microsoft, Internet egress, cookies from a real login, credential handling,
  at-rest protection, installer support, upgrades, backups, crash recovery or user deletion.
- Restart evidence is graceful shutdown, not abrupt host failure or power-loss recovery.
- Resource settings and transport are experimental. The broker uses a global lock, in-memory state,
  and test-only fault injection. Do not promote it directly into production.
- The Alpine package version is a synthetic test dependency. A production image needs a maintained,
  pinned release process, security updates, both supported architectures and browser sandbox checks.
- The host service is trusted to manage all its runtime profiles; containers do not protect profiles
  from a compromised host broker or the host OS administrator.

The [build spec](../../docs/superpowers/specs/2026-10-22-outlook-user-setup-build.md) describes the
proposed production seams and the unproven paths that still need implementation and live evidence.
