#!/usr/bin/env python3
"""Guard-removal proof for the Mac link. Each control removes one guard from the Rust source
and requires the named test to fail. Sources are restored byte for byte, even on interrupt.
Run from anywhere with the task cargo environment sourced."""
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
FLOW = "capture_flow"
AUDIO = "capture_audio"

CONTROLS = [
    ("wrong secret accepted", "capture_auth.rs", "a.len() == stored_hash.len() &&", "true ||", FLOW, "a_wrong_secret_or_connection_is_refused"),
    ("start limit not charged", "capture_start.rs", "store::take_budget(host, at)?;", "", FLOW, "the_eleventh_start_in_a_minute_is_rate_limited"),
    ("cancelled key not honoured", "capture_start.rs", "if store::cancelled(host, request_key)? {", "if false {", FLOW, "cancelling_before_the_start_blocks_a_late_start_with_that_key"),
    ("busy Mac not refused", "capture_start.rs", "if store::occupied(host, &device, connection[\"connection_id\"].as_str().unwrap_or_default())? || holds {", "if false {", FLOW, "a_busy_mac_refuses_a_second_start"),
    ("claim skips permission check", "capture_connection.rs", "    auth::require_recording(host, &native.device_id, native.capability_revision)?;\n    let status", "    let status", FLOW, "a_mac_that_lost_permission_cannot_claim"),
    ("model route not required", "capture_start.rs", "return Err(Failure::new(CaptureCode::ProcessingUnavailable).into());", "return Ok(Response::new(200, json!({})));", FLOW, "a_start_needs_a_model_route_a_browser_and_a_real_meeting"),
    ("relink route answers 200", "capture_routes.rs", "Ok(Failure::new(CaptureCode::RelinkRequired).response())\n}\n\n/// Only", "Ok(Response::new(200, json!({})))\n}\n\n/// Only", FLOW, "the_old_relink_routes_always_answer_410"),
    ("failure echoes the request", "capture_errors.rs", "None => json!({\"code\": self.code.as_str()}),", "None => json!({\"code\": self.code.as_str(), \"echo\": \"PLANTED-MARKER-7f3a91\"}),", FLOW, "a_malformed_body_is_a_400_with_a_code_only"),
    ("audio body cap removed", "capture_routes.rs", "capped(body, 5_200_000)", "capped(body, usize::MAX)", AUDIO, "an_oversize_audio_body_is_413"),
    ("device credential not compared", "capture_native.rs", "|| !proof_matches(credential, stored)", "|| false", AUDIO, "a_wrong_or_missing_credential_is_the_same_401"),
    ("replayed clip transcribed again", "capture_audio_service.rs", "if result[\"retryable\"] != json!(true) || !receipts::retry(host, &grant_id, &prior, at)? {", "if false {", AUDIO, "the_same_clip_again_answers_the_same_and_is_not_transcribed_twice"),
    ("silent clip sent to the model", "capture_audio_service.rs", "    if near_silent(&clip.pcm) {\n        return Ok(vec![]);", "    if false {\n        return Ok(vec![]);", AUDIO, "a_silent_clip_is_not_sent_to_the_model"),
    ("future clip admitted", "capture_audio.rs", "clip.end_ms > now_ms ||", "false ||", AUDIO, "a_clip_ending_in_the_future_conflicts"),
    ("unreported recording admitted", "capture_audio.rs", "|| observed[\"phase\"] != \"recording\"", "|| false", AUDIO, "a_mac_that_reports_paused_is_interrupted"),
    ("lost permission keeps the grant", "capture_native.rs", "pub fn settle<H: Host + ?Sized>(host: &H, grant: &Value) -> Result<(), Stop> {", "pub fn settle<H: Host + ?Sized>(host: &H, grant: &Value) -> Result<(), Stop> {\n    if true {\n        return Ok(());\n    }", AUDIO, "a_lost_recording_permission_revokes_the_grant"),
    ("row level security removed", "../tests/common/mod.rs", ".filter(|r| r[\"owner_user_id\"] == actor && matches(r, &query.filter, actor))", ".filter(|r| matches(r, &query.filter, actor))", AUDIO, "another_person_cannot_send_audio_into_the_meeting"),
]


def run(test_file, name):
    result = subprocess.run(["cargo", "test", "--test", test_file, name], cwd=SRC, capture_output=True, text=True)
    return result.returncode, result.stdout + result.stderr


def main():
    failed = []
    for label, file, before, after, suite, test in CONTROLS:
        path = SRC / file
        original = path.read_bytes()
        text = original.decode()
        if text.count(before) != 1:
            failed.append(f"{label}: anchor not found exactly once in {file}")
            continue
        try:
            path.write_bytes(text.replace(before, after).encode())
            code, out = run(suite, test)
        finally:
            path.write_bytes(original)
        red = code != 0 and f"{test} ... FAILED" in out
        print(("red as required   " if red else "NOT RED          ") + label, flush=True)
        if not red:
            failed.append(f"{label}: {test} did not fail with the guard removed")
    code = max(run(FLOW, "")[0], run(AUDIO, "")[0])
    if code != 0:
        failed.append("restored sources are not green")
    print("green after restore" if code == 0 else "NOT green after restore")
    for line in failed:
        print("FAIL", line, file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
