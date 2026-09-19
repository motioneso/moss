# Jev terminal pilot (macOS)

A standalone experiment: classify your foreground activity and its relevance to an optional goal.
No Moss server, Python packages, browser extension, screenshots, or background service.
This is not a shipped Moss feature; it does not send messages or change tasks.

Requires macOS, Python 3.9+, and Apple's Command Line Tools (`xcode-select --install` if needed).
The Python runner compiles the small native Swift sampler automatically on the first Mac run.

## Run on your Mac

From this branch's checkout (or copy this entire `tools/jev-pilot` directory onto your Mac):

```bash
cd ~/Jarv1s/tools/jev-pilot
python3 -B pilot.py --list-apps
```

Pick the bundle IDs of apps you want to observe. Example for Safari:

```bash
# Local preview only. Switch to Safari after starting it.
python3 -B pilot.py --allow com.apple.Safari --titles --minutes 1
```

Window titles require Accessibility permission. When prompted, open System Settings →
Privacy & Security → Accessibility and enable the terminal/helper named by macOS.
If capture stays `permission_denied`, quit and reopen the terminal after granting access.
Without `--titles`, only the app name/ID is collected and Accessibility is unnecessary.
No Screen Recording or Automation permission is requested.

If a title is insufficient, opt in to **window text** with `--text` (also enables titles):

```bash
# Preview first; switch to Safari and leave it foreground for at least 15 seconds.
python3 -B pilot.py --allow com.apple.Safari --text --minutes 1

# Send app, title and the bounded text excerpt to Jev.
python3 -B pilot.py --allow com.apple.Safari --text --live --save
```

This uses the same Accessibility permission. It reads static text exposed within the focused
window's bounds, skips editable/secure controls, and sends at most 800 redacted characters.
The native walk stops at 250 elements or roughly 1.5 seconds; it does not read every page element.
Clipping/visibility depends on the app's Accessibility tree, so inspect the preview for unwanted
content. Private text elsewhere in a page can still be exposed as static text. No DOM scripting
or screenshots are used. Some apps/editors expose no usable static text.

Results now include `evidence`, `title_chars` and `text_chars`. If `text_chars` is zero, Jev did
not receive window text; an `unknown` classification is not proof that Jev failed to understand it.
Changing scores or scrolling won't keep resetting the dwell timer when the app/title stays the
same. Results describe the captured excerpt, which may differ from text displayed moments later.

The preview shows the **exact JSON request**, including fixed questions. Review it before
running live. Titles and window text may contain sensitive information despite basic redaction. Do not allow
password managers, messaging, banking apps or a browser used for private browsing. Private
tabs cannot reliably be detected; use a dedicated work browser or stop capture.

```bash
# Live activity classification + relevance to your chosen goal, for 25 minutes.
python3 -B pilot.py --allow com.apple.Safari --titles \
  --goal "Prepare the project estimate" --live --save
```

Enter your TypeSafe API key at the hidden prompt. It is not saved by the program. Alternatively,
the runner reads `TYPESAFE_API_KEY` from the environment; don't paste a key into command history.
Omit `--goal` to test general activity classification; alignment then always becomes
`insufficient_evidence`. Repeat `--allow` to include other apps. Use a non-sensitive goal alias:
the command-line goal is visible in process listings and shell history.

**Ctrl-C stops it.** There is no resident daemon. For a break, stop and restart afterward.
Each run expires after `--minutes` (default 25). Do not use Ctrl-Z as the pause control.

## What you see

Once an allowed foreground context has been stable for 15 seconds, the runner submits one
request containing two Choice questions. Calls are at least 60 seconds apart. Example shape:

```json
{
  "activity": "research_reading",
  "alignment": "necessary_detour",
  "activity_probability": 0.86,
  "alignment_probability": 0.79
}
```

These are model judgments, not facts. Check whether they match what you are actually doing.
Especially try relevant research, unrelated browsing, writing, and a necessary detour. The API
returns confidence too; neither confidence nor probability proves accuracy. No nudges are sent.

`--save` writes categorical results, UTC timestamps, app bundle IDs and token counts to a new
owner-only JSONL file under `~/Library/Application Support/JevPilot/`. It also records evidence
level and character counts. It does not write window text, titles,
your goal, request bodies or the API key to that file. By default nothing is saved. Saved files
remain until you delete them; this tiny pilot has no retention service.

To produce a small summary you can review and paste into Moss:

```bash
python3 -B pilot.py --summary "$HOME/Library/Application Support/JevPilot/SESSION.jsonl"
```

Use the actual filename printed at startup. Summary counts represent **sampled classifications**,
not minutes spent or the whole day. Gaps, idle time, excluded apps and fast context changes aren't
classified. Manually delete a session file when finished; TypeSafe's retention is separate.

## Limits and failure behavior

- Samples every 5 seconds using a short-lived native process; no keystroke or clipboard capture.
  This deliberately replaces the planned event observers for the first terminal trial.
- Only explicitly allowed apps are read. Titles and static window text are separately opt-in,
  capped/redacted before a request. No DOM, URL/domain extraction or OCR is used. Missing text
  falls back to title evidence, then app-only evidence.
- A goal plus up to three prior app segments provides a small amount of context. There is no
  persistent model memory. A changed title can restart the dwell timer; low coverage is a useful
  pilot finding rather than evidence that the user was idle.
- Idle >=2 minutes and detectable lock/inactive sessions suspend sampling. Lock detection is
  best effort across macOS versions; use Ctrl-C when privacy matters. Sleep/scheduling gaps clear
  context, and results are discarded if the foreground context changed during the request.
- Default cap is 120 attempted requests **per run**, including failures; restarting resets it.
  `--max-calls 10` lowers the cap. `--interval 120` lowers frequency. There is no global daily cap.
- Provider timeout is 5 seconds. Invalid output produces no classification. Authentication errors
  and rate limits stop the run; other failures wait for the next normal interval. No retry queue,
  automatic provider switch or raw provider-error logging. Redirects are refused.
- `--live` sends approved app metadata, optional minimized titles/text and the goal to TypeSafe.
  Observation text remains untrusted even when passed as JSON. The model has no tools/actions.
  Review TypeSafe's data handling before sending sensitive work.

## Checks without observing your screen

```bash
# No key, no network, no Mac required: synthetic request preview.
python3 -B pilot.py --demo --titles --goal "Prepare the project estimate"

# Optional live API smoke test with synthetic data only.
python3 -B pilot.py --demo --titles --goal "Prepare the project estimate" --live

# Offline standard-library tests from this directory.
python3 -B -m unittest -v
```

The API contract follows [TypeSafe's reference](https://docs.typesafe.ai/api):
`POST https://api.typesafe.ai/v1/systemone`, `model: jev-latest`, two `choice` questions with
`criteria` maps, and `choice`/`probabilities`/`confidence` answers. Verified against the documentation
on 2026-09-19. Native compilation, actual Accessibility behavior, and real classification quality
must still be checked on a Mac with a TypeSafe key.
