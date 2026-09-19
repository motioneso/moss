# Jev terminal pilot (macOS)

A standalone experiment: classify your foreground activity and its relevance to an optional goal.
No Moss server, Python packages, browser extension, or background service.
The activity runner uses Accessibility; a separate opt-in probe tests a manually selected screenshot.
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

Capture prefers text inside a webpage's Accessibility area over browser controls when it finds
both within its scan budget. `text_source` reports `page`, `window`, or `none`;
`text_scan_limited` means pending nodes remained when a bound was reached, not that capture failed.

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
Activity choices include research/reading, writing/editing, coding, communication, planning/admin,
shopping, entertainment, other and unknown. Browsing product listings counts as shopping; a purchase
or declared goal is not required. Whether shopping supports your goal is a separate judgment.
Especially try relevant research, unrelated browsing, writing, and a necessary detour. The API
returns confidence and the full option probability distributions too; neither confidence nor
probability proves accuracy. No OS notifications are sent.

## Flag sustained distraction

```bash
python3 -B pilot.py --live --allow com.apple.Safari --text --save \
  --goal "Research accommodation for a Liverpool trip" \
  --flag-after-minutes 5 --distraction-probability 0.8 --idle-minutes 10
```

The runner calculates time locally. Jev only judges the current evidence. Each result includes
`distraction_seconds` and `focus_flag`; crossing the threshold prints `FOCUS FLAG` in the terminal.
The duration is a conservative estimate from samples, not continuous proof of attention.

- Default: 5 accumulated minutes, with chosen alignment probability at least 0.8. These are
  pilot thresholds to tune against your judgments, not calibrated guarantees.
- Credit intervals bracketed by two qualifying `distracted` results, while capture remains
  active in allowed apps throughout the 5-second checks. Different distracting pages/apps can
  contribute to the same episode. No credit before the first confident result.
  With a 60-second interval, five minutes normally needs six qualifying results.
- Page changes no longer discard an interval solely because the title changed. This estimate can
  include unclassified intermediate visits between two distracting samples; it is not proof that
  every page visited was distracting. Rapid switching that prevents a stable sample can still
  undercount activity. Excluded apps, failed calls and uncertain results break the pending interval
  and never backfill it. Already credited time survives a brief gap.
- A confident `focused` or `necessary_detour` result clears the episode. A weaker result pauses it.
  Idle, revoked/unavailable capture, a gap of more than 15 seconds between capture checks, or no
  qualifying distraction result for `max(135, 2 * interval + 15)` seconds clears it too.
- One flag per episode, with `--cooldown-minutes 30` between flags by default. A new episode must
  accumulate its own qualifying time. Restarting the program clears timing and cooldown state.
- No goal means no timing or flagging. Preview mode does not call Jev or accumulate classifications.
- `--idle-minutes 10` is the new default (previously 2), adjustable from 0.5 to 60. It means no
  keyboard/mouse input, not proven absence. A longer timeout permits passive reading/watching to
  count, but also permits capture longer after you walk away. Detected lock/sleep still stops capture
  regardless of this timeout; Ctrl-C remains the explicit stop control.

The full distributions help distinguish a close focused/detour decision from a clear distraction.
Capture still observes only the apps you explicitly allow. Other activity is a gap, not distraction.

`--save` writes categorical results, UTC timestamps, app bundle IDs and token counts to a new
owner-only JSONL file under `~/Library/Application Support/JevPilot/`. It also records evidence
level, character counts, capture source, probabilities and timing/flags. It does not write window text, titles,
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
- Idle beyond `--idle-minutes` and detectable lock/inactive sessions suspend sampling. Lock detection is
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

## Single-screenshot vision experiment

`vision.py` tests perception separately from the live Mac capture. It never captures
the screen itself. Choose a non-sensitive screenshot yourself (Shift-Command-4 on
Mac), inspect/crop it, and supply that PNG or JPEG. The whole supplied image is
uploaded with `--live`; Accessibility's filtering does not apply to pixels.

```bash
# Preview: validates file size/type, shows instructions; no network or key needed.
python3 -B vision.py ~/Desktop/example.png

# One paid request. Reads OPENROUTER_API_KEY or prompts for it without echoing.
python3 -B vision.py ~/Desktop/example.png --live

# Compare the same image with the other budget model (another paid request).
python3 -B vision.py ~/Desktop/example.png --live --model google/gemini-2.5-flash-lite

# Watch Desktop, then take screenshots normally. Ctrl-C stops.
python3 -B vision.py --watch "$HOME/Desktop" --live

# Watch and send each visual description to Jev for activity and goal alignment.
python3 -B vision.py --watch "$HOME/Desktop" --live --jev \
  --goal "Research accommodation for a Liverpool trip"
```

`--jev` makes a second request after each successful vision request. It reads
`TYPESAFE_API_KEY` or prompts for it without echoing; the OpenRouter key is read
separately from `OPENROUTER_API_KEY`. `--goal` requires `--jev`, and omitting the
goal keeps Jev's alignment answer at `insufficient_evidence`. Each output line
contains the vision observation and cost plus a nested `jev` judgment and its
separate usage. A Jev authentication, credit, or rate-limit error preserves the
vision result and stops the watcher; other Jev failures preserve the vision result
and skip only that image's judgment.

Watch mode skips files already present when it announces "Watching" and checks
every two seconds for new PNG/JPEG filenames (no subfolders or symlinks). It waits
for a non-empty file's size and modification time to remain unchanged across two
checks before processing it. This is a best-effort write-completion check; a copy
that pauses longer can still be incomplete. Each filename is attempted once per
run, even on failure or later edits. Restarting skips all files already present.
It sends **all new PNG/JPEG files**, including downloads, so avoid saving private
images there while watching. Omit `--live` for a no-upload preview.
Watch mode stops after 20 new files by default (`--max-images 10` changes this).
Authentication, credit, or rate-limit errors stop the watcher; other file/request
errors skip that image. Results include the filename to match each screenshot.

Default: `qwen/qwen3.7-flash`. Maximum image file size 8 MiB; maximum output 256
tokens; reasoning disabled; no retries or model fallback. The file-size cap is
not an image-token or monetary cap. Set a spending limit on your OpenRouter key
if you need a hard budget. No resizing or redaction of image pixels is performed.

Results show the short visual observation, elapsed seconds, provider-reported
token usage, and `cost_credits` (OpenRouter's reported charge; null if absent).
Invalid/truncated model descriptions are rejected while retaining reported usage.
Only the selected image is sent to OpenRouter and its model provider; the program
does not save images, descriptions, or keys. Descriptions appear in your terminal
and may contain sensitive text. The screenshot you created remains until deleted.

The Jev request sends only a bounded, sanitized description with
`evidence: "screenshot_description"`. It does not invent an app or bundle ID, and
its instructions use ordinary page content, headings and listings as evidence of
what is visible. Clearly quoted logs, chat, email, terminal output and document
content are treated as displayed content rather than proof of current activity: a
log saying shopping is not shopping, while a hotel-results page can support
research or shopping. This watcher has no duration accumulation or focus flagging;
use the main pilot for Accessibility-based timing while this tests screenshot
perception.

For persistent key storage in the Mac's default zsh, use this hidden prompt:

```zsh
mkdir -p "$HOME/.config/jev-pilot"
(
  umask 077
  read -rs 'jev_key?OpenRouter API key: '
  printf '\n'
  printf '%s' "$jev_key" > "$HOME/.config/jev-pilot/openrouter-key"
)
chmod 600 "$HOME/.config/jev-pilot/openrouter-key"
export OPENROUTER_API_KEY="$(cat "$HOME/.config/jev-pilot/openrouter-key")"
```

This stores plaintext with file mode 600. In a new terminal run only the export
line. The script does not automatically load `.env` files. Do not put keys in the
repo or paste them into chat. Alternatively, skip storage and use its hidden prompt.

Compare observations against what each screenshot actually shows, especially
destinations, maps, games, and video. Live model quality, billing, and latency still
need verification using your OpenRouter account; offline tests do not establish them.

## Offline and synthetic checks

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
