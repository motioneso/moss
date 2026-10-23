# Stage 4 UAT campaign runner

Reference copy of the runner and evidence scanner used for the stage 4 real-model browser runs
(R18 attachment set, R19 eight-spec set). Tracked by #3538.

## Files

| File               | Role                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `run.py`           | Campaign runner: `prepare`, `build`, `test`, `release` phases                  |
| `scan_evidence.py` | Read-only masked token scan over a finished campaign folder                    |
| `PROTOCOL.md`      | Operating protocol the runner was reviewed against, unchanged from the R19 run |

## What the runner does

- Exports one pinned source commit (`SOURCE` in `run.py`) into a private `campaign-<nonce>/` folder.
- Builds a disposable image from that export, adding headed Chrome and a virtual display.
- Runs each spec file separately on a sealed internal network: one worker, zero retries, stop at the
  first failure.
- Uses one product Claude sign-in per campaign. The operator gets file paths for the link and code,
  never their contents. No host credentials or proxy keys are read.
- Tears down in a fixed order: stop browser and app, remove credential files in a network-less
  cleaner, verify no setup token survives, then remove containers, volumes, network and port claim.
  The image hold is released last.

## Prerequisites

- Local Docker on the default Unix socket, with the pinned `docker-buildx` plugin in
  `~/.docker/cli-plugins` and the pinned Postgres and BuildKit images already present (digests in
  `run.py`).
- `devports` at `~/.local/bin/devports`, for the shared dev port range. Production is never targeted.
- A checkout containing `SOURCE`. Set `MOSS_UAT_CAMPAIGN_REPO` to it; the default is `~/Jarv1s`.

## Running

Each phase needs its own explicit approval. See `PROTOCOL.md` for commands and limits. After
`test` exits and cleanup shows nothing left, run once:

```
python3 -I scan_evidence.py campaign-<nonce>
```

Any hit or unreadable file fails the run.

## Provenance

These are copies of the hash-pinned R19 originals. `scan_evidence.py` and `PROTOCOL.md` are
byte-identical. `run.py` differs in one line: the source repository path became the
`MOSS_UAT_CAMPAIGN_REPO` environment variable instead of a fixed local folder. Original SHA-256:

```
9053e387d484dc06e847d2235153d13e24facb24abfcfcf034a77c09a4e00bbd  run.py
880ad9e151f41c534d04d5f47c8c11a60014bc0badbb1c4ad728b9c0baf7d5e2  scan_evidence.py
31c8a79f5f6b1ab8fece6d556dad9af7c453610842a119c463005abdc3f1dadf  PROTOCOL.md
```

The runner is pinned to stage 4 commits and spec titles. Reuse for a new campaign means editing
those pins and getting the runner reviewed again.

## Known limits

- `scan_evidence.py` only looks for Claude tokens. It does not look for session cookies or sign-in
  links.
- The browser-push spec (3134) needs an outside push service, which the sealed network does not
  give it. It can fail for that reason alone.
- A deadline stop reports "deadline exceeded" even when no test started.
