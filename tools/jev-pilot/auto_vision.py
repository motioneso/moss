#!/usr/bin/env python3
"""Capture the allowed foreground window, classify its pixels, and track focus."""

import argparse
from datetime import datetime, timezone
import getpass
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from focus import FocusTracker
from pilot import observation, sampler
from pilot import evaluate as evaluate_jev
from vision import (FATAL_PROVIDER_ERRORS, MODELS, evaluate as evaluate_vision,
                    image_data, request_body, screenshot_payload)

SCREENSHOTS = Path.home() / "Library/Caches/JevPilot/screenshots"
MAX_RESULT_AGE = 30.0


def capture_metadata(binary, allow, idle_seconds):
    """Read one bounded native foreground-window record."""
    args = [str(binary), *sorted(allow), "--titles", "--window-id",
            "--idle-seconds", str(idle_seconds)]
    try:
        proc = subprocess.run(args, capture_output=True, timeout=4, check=True)
        if len(proc.stdout) > 8192:
            raise ValueError("invalid_capture")
        raw = json.loads(proc.stdout)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError, UnicodeError):
        raise ValueError("capture_failed") from None
    if not isinstance(raw, dict):
        raise ValueError("invalid_capture")
    return raw


def request_permission(binary, action):
    try:
        proc = subprocess.run([str(binary), action], capture_output=True, timeout=5, check=True)
        if len(proc.stdout) > 4096:
            raise ValueError("invalid_permission_response")
        result = json.loads(proc.stdout)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError, UnicodeError):
        raise ValueError("permission_check_failed") from None
    if not isinstance(result, dict) or result.get("accessibility" if action == "--request-access"
                                                   else "screen_recording") is not True:
        raise ValueError("accessibility_permission_denied" if action == "--request-access"
                         else "screen_recording_permission_denied")


def context_key(raw):
    if not isinstance(raw, dict) or raw.get("status") != "ok":
        return None
    bundle = raw.get("bundle_id")
    window_id = raw.get("window_id")
    title = raw.get("title", "")
    if (not isinstance(bundle, str) or not bundle or
            type(window_id) is not int or window_id <= 0 or
            not isinstance(title, str)):
        return None
    return bundle, int(window_id), title


def same_context(raw, expected):
    return context_key(raw) == expected


def _screenshot_path(directory):
    try:
        fd, name = tempfile.mkstemp(prefix="window-", suffix=".png", dir=directory)
        os.close(fd)
        path = Path(name)
        path.unlink()
        return path
    except OSError:
        raise ValueError("screenshot_cleanup_failed") from None


def _delete_image(path):
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError:
        raise ValueError("screenshot_cleanup_failed") from None


def screenshot_bytes(binary, allow, expected, idle_seconds, directory, cancel):
    """Capture exactly one allowed window and unlink it before returning its bytes."""
    if cancel.is_set():
        return None
    raw = capture_metadata(binary, allow, idle_seconds)
    if not same_context(raw, expected):
        cancel.set()
        return None
    path = _screenshot_path(directory)
    try:
        try:
            subprocess.run(["/usr/sbin/screencapture", "-x", "-l", str(expected[1]), str(path)],
                           capture_output=True, timeout=10, check=True)
            captured_at = time.monotonic()
            if cancel.is_set():
                return None
            raw_image, mime = image_data(path)
        except (subprocess.SubprocessError, OSError, ValueError):
            raise ValueError("screen_capture_failed") from None
        return raw_image, mime, captured_at, _safe_capture_time()
    finally:
        _delete_image(path)


def _safe_capture_time():
    return datetime.now(timezone.utc).isoformat()


def classify_window(binary, allow, expected, idle_seconds, directory, model,
                    openrouter_key, typesafe_key, goal, cancel):
    """Worker body. It owns no observation/timer state and never prints raw model text."""
    captured = screenshot_bytes(binary, allow, expected, idle_seconds, directory, cancel)
    if captured is None:
        return {"stale": True}
    raw_image, mime, captured_at, captured_at_utc = captured
    if cancel.is_set():
        return {"stale": True}
    try:
        before_upload = capture_metadata(binary, allow, idle_seconds)
    except ValueError:
        raise
    if not same_context(before_upload, expected):
        cancel.set()
        return {"stale": True}
    if cancel.is_set():
        return {"stale": True}
    if not openrouter_key:
        return {"preview_only": True, "captured_at": captured_at,
                "captured_at_utc": captured_at_utc}
    started = time.monotonic()
    visual = evaluate_vision(request_body(raw_image, mime, model), openrouter_key)
    vision_elapsed = round(time.monotonic() - started, 2)
    if cancel.is_set() or "observation" not in visual:
        return {"stale": True, "visual": visual}
    # A context check after vision prevents a late visual answer starting a Jev call.
    if not same_context(capture_metadata(binary, allow, idle_seconds), expected):
        cancel.set()
        return {"stale": True, "visual": visual}
    if cancel.is_set():
        return {"stale": True, "visual": visual}
    jev = evaluate_jev(screenshot_payload(visual["observation"], goal), typesafe_key)
    stale = cancel.is_set()
    try:
        stale = stale or not same_context(capture_metadata(binary, allow, idle_seconds), expected)
    except ValueError:
        stale = True
    return {"stale": stale, "visual": visual, "jev": jev,
            "captured_at": captured_at, "captured_at_utc": captured_at_utc,
            "vision_elapsed_seconds": vision_elapsed}


def prepare_directory():
    SCREENSHOTS.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        SCREENSHOTS.chmod(0o700)
    except OSError:
        raise ValueError("screenshot_directory_failed") from None
    return SCREENSHOTS


def _sanitize_error(exc):
    value = str(exc)
    return value if value in FATAL_PROVIDER_ERRORS or value in {
        "network_error", "response_too_large", "invalid_response", "invalid_or_truncated_observation",
        "request_too_large", "capture_failed", "invalid_capture", "screen_capture_failed",
        "screenshot_cleanup_failed", "screen_recording_permission_denied",
        "accessibility_permission_denied", "permission_check_failed", "screenshot_directory_failed",
    } else "vision_or_jev_failed"


def _print_wait(status, last_status):
    status = status if status in {"idle", "excluded", "permission_denied"} else "unavailable"
    if status != last_status:
        print("Waiting: " + status, flush=True)
    return status


def run(args, binary, openrouter_key, typesafe_key):
    deadline = time.monotonic() + args.minutes * 60
    current = None
    current_context = None
    changed = 0.0
    last_tick = 0.0
    last_start = -math.inf
    calls = 0
    last_status = None
    tracker = FocusTracker(args.flag_after_minutes * 60, args.distraction_probability,
                           args.cooldown_minutes * 60, max(135, 2 * args.interval + 15))
    executor = ThreadPoolExecutor(max_workers=1)
    future = None
    cancel = None
    inflight_context = None
    invalidated = False
    run_directory = tempfile.TemporaryDirectory(prefix="run-", dir=str(args.screenshot_dir))
    args.screenshot_dir = Path(run_directory.name)
    try:
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now - last_tick > 15:
                current = None
                current_context = None
                tracker.uncertain()
                if future is not None:
                    invalidated = True
                    cancel.set()
            last_tick = now
            raw = capture_metadata(binary, args.allow, args.idle_minutes * 60)
            obs = observation(raw, args.allow, True)
            context = context_key(raw) if obs else None
            if context is None:
                obs = None
            tracker.observe(now, context, idle=raw.get("status") in ("idle", "permission_denied", "unavailable"))
            if obs is None:
                current = None
                current_context = None
                if future is not None:
                    invalidated = True
                    cancel.set()
                    tracker.uncertain()
                last_status = _print_wait(raw.get("status", "unavailable"), last_status)
            else:
                last_status = None
                if context != inflight_context and future is not None:
                    invalidated = True
                    cancel.set()
                    tracker.uncertain()
                if context != current_context:
                    changed = now
                current = obs
                current_context = context

            if future is not None and future.done():
                result = future.result()
                future = None
                inflight_context = None
                was_invalid = invalidated
                invalidated = False
                cancel = None
                if was_invalid or result.get("stale"):
                    tracker.uncertain()
                    print("Dropped stale result.", flush=True)
                elif result.get("preview_only"):
                    print(json.dumps({"preview_only": True, "app": current["bundle_id"] if current else "",
                                      "title_chars": len(current.get("title", "")) if current else 0,
                                      "capture": "single_allowed_window", "image_saved": False},
                                     ensure_ascii=True), flush=True)
                elif now - result["captured_at"] > MAX_RESULT_AGE:
                    tracker.uncertain()
                    print("Dropped stale result.", flush=True)
                else:
                    jev = result.get("jev")
                    flag = tracker.vote(result["captured_at"], jev["alignment"],
                                        jev["alignment_probability"])
                    visual = result.get("visual", {})
                    row = {"at": result["captured_at_utc"], "app": current["bundle_id"] if current else "",
                           "evidence": "screenshot", "title_chars": len(current.get("title", "")) if current else 0,
                           "vision_model": args.model,
                           "vision_elapsed_seconds": result["vision_elapsed_seconds"],
                           "vision_cost_credits": visual.get("cost_credits"),
                           "vision_usage": visual.get("usage", {}),
                           "distraction_seconds": round(tracker.seconds, 1), "focus_flag": flag, **jev}
                    print(json.dumps(row, ensure_ascii=True), flush=True)
                    if flag:
                        print(f"FOCUS FLAG: {tracker.seconds / 60:.1f} supported minutes of distraction. "
                              "Return to your goal, or stop the pilot for a break?", flush=True)
                calls += 1
                if calls >= args.max_calls:
                    print("Session call budget reached.", flush=True)
                    break
                if args.once:
                    break

            if future is None and obs is not None and now - changed >= 15 and now - last_start >= args.interval:
                cancel = threading.Event()
                inflight_context = context
                invalidated = False
                future = executor.submit(classify_window, binary, args.allow, context,
                                          args.idle_minutes * 60, args.screenshot_dir, args.model,
                                          openrouter_key, typesafe_key, args.goal, cancel)
                last_start = now
            time.sleep(5)
    except KeyboardInterrupt:
        if cancel is not None:
            cancel.set()
        print("Stopping; waiting for the in-flight request to finish before cleanup.", flush=True)
        raise
    finally:
        if cancel is not None:
            cancel.set()
        executor.shutdown(wait=True, cancel_futures=True)
        run_directory.cleanup()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Upload screenshots and bounded descriptions")
    parser.add_argument("--allow", action="append", default=[], metavar="BUNDLE_ID")
    parser.add_argument("--goal", default="")
    parser.add_argument("--minutes", type=int, default=25)
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--max-calls", type=int, default=20)
    parser.add_argument("--model", choices=MODELS, default=MODELS[0])
    parser.add_argument("--flag-after-minutes", type=float, default=5)
    parser.add_argument("--distraction-probability", type=float, default=0.7)
    parser.add_argument("--cooldown-minutes", type=float, default=30)
    parser.add_argument("--idle-minutes", type=float, default=10)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    if not args.allow:
        parser.error("Repeat --allow BUNDLE_ID for each permitted app.")
    if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,149}", value) for value in args.allow):
        parser.error("Invalid bundle ID.")
    if not 1 <= args.minutes <= 480 or not 60 <= args.interval <= 3600 or not 1 <= args.max_calls <= 20:
        parser.error("Use 1–480 minutes, 60–3600 seconds interval and 1–20 max calls.")
    if not 0.5 <= args.idle_minutes <= 60 or not 0.5 <= args.flag_after_minutes <= 120:
        parser.error("Use 0.5–60 idle minutes and 0.5–120 flag minutes.")
    if not 0.5 <= args.distraction_probability <= 1 or not 0 <= args.cooldown_minutes <= 480:
        parser.error("Use 0.5–1 probability and 0–480 cooldown minutes.")
    try:
        args.screenshot_dir = prepare_directory()
        binary = sampler()
        request_permission(binary, "--request-access")
        request_permission(binary, "--request-screen-access")
        openrouter_key = typesafe_key = ""
        if args.live:
            print("LIVE: single foreground-window screenshots and bounded observations will be uploaded. Ctrl-C stops capture.", flush=True)
            openrouter_key = os.environ.get("OPENROUTER_API_KEY") or getpass.getpass("OpenRouter API key (hidden): ")
            typesafe_key = os.environ.get("TYPESAFE_API_KEY") or getpass.getpass("TypeSafe API key (hidden): ")
            if (not openrouter_key or not openrouter_key.isascii() or not openrouter_key.isprintable()
                    or any(c.isspace() for c in openrouter_key)
                    or not typesafe_key or not typesafe_key.isascii() or not typesafe_key.isprintable()
                    or any(c.isspace() for c in typesafe_key)):
                parser.error("API keys must be non-empty and contain no whitespace.")
        else:
            print("PREVIEW ONLY: captures one allowed window locally, sends nothing, and deletes the image.", flush=True)
        run(args, binary, openrouter_key, typesafe_key)
    except KeyboardInterrupt:
        print("Stopped. No background process remains.", flush=True)
    except (EOFError, ValueError, OSError, subprocess.SubprocessError) as exc:
        print("Pilot stopped: " + _sanitize_error(exc), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
