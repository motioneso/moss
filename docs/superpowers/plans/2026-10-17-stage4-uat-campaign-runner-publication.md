# Plan: publish the stage 4 UAT campaign runner (#3538)

## Goal

Put the R19 campaign runner, its evidence scanner and its protocol in the repo as a cleaned
reference copy, reviewed on a draft PR. No product, CI or spec change.

## Decisions

- **Location:** `scripts/uat-campaign/`, next to the other `scripts/` tools. Campaign folders,
  the lock file and scan reports are git-ignored there because the runner writes them beside
  itself.
- **Copy, do not refactor.** The originals are hash-pinned and were reviewed seven times. The
  published copy keeps them byte-identical except where publication forces a change, so the
  review record still applies.
- **One forced edit.** The source repository path was a fixed local folder. It becomes
  `MOSS_UAT_CAMPAIGN_REPO`, defaulting to `~/Jarv1s`. Nothing else in `run.py` names a private
  path, address or account. The fixture account it seeds is the existing public UAT fixture.
- **Original hashes in the README**, so anyone can check the copy against the private originals.
- **Older tooling not published.** The command controller and collector pinned for
  `scripts/uat-host` and `scripts/uat-collector` were not used by R18 or R19, and no accepted
  receipt depends on them.

## Tasks

1. Copy `run.py`, `scan_evidence.py` and `PROTOCOL.md` from the frozen R19 folder. Never edit the
   originals.
2. Apply the repo-path edit; confirm the diff against the original is exactly one line.
3. Write `README.md` and `.gitignore`.
4. Public-repo scan of every added file: credentials, sign-in codes or links, private hostnames,
   LAN and tailnet addresses, absolute home paths, personal email.
5. Format check (`prettier --check`) on the added Markdown.
6. Open the draft PR with `Category: N/A`. Get one independent review from a different model and
   fix must-fix findings.

## Verification

- `diff` of each copy against its original: two identical, one with a single changed line.
- `python3 -m py_compile` on both scripts.
- Scan counts recorded on the PR.

## Out of scope

Running a campaign, changing the runner's behaviour, merging before stage 4 acceptance.
