//! Ring receiver rules ported from the TypeScript tests: size and range limits, bad WAV
//! rejection, packet framing, sidecar reading, manifest identity and voice rules.
use moss_meetings_module::ring_errors::{Invalid, RingCode};
use moss_meetings_module::ring_source::*;
use moss_meetings_module::ring_voice::*;
use serde_json::{json, Value};

const DEVICE: &str = "11111111-1111-4111-8111-111111111111";
const ENABLEMENT: &str = "22222222-2222-4222-8222-222222222222";

fn wav(samples: usize) -> Vec<u8> {
    let data = samples * 2;
    let mut b = Vec::new();
    b.extend(b"RIFF");
    b.extend(((data + 36) as u32).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(16000u32.to_le_bytes());
    b.extend(32000u32.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend((data as u32).to_le_bytes());
    b.extend(vec![0u8; data]);
    b
}

fn manifest(wav_len: u64, destination: Value, id: &str) -> Value {
    let f = |n: u64| json!({"byteLength": n, "sha256": "a".repeat(64)});
    json!({"version": 3, "sourceDeviceId": DEVICE, "recordingId": id, "destination": destination,
        "packets": f(10), "sidecar": f(10), "wav": f(wav_len)})
}

#[test]
fn error_codes_match_the_report() {
    let report = std::fs::read_to_string(
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../../docs/superpowers/specs/2026-11-11-rust-phase5-meetings-part1-report.md"),
    )
    .expect("report");
    let section = report.split("## Part 8").nth(1).expect("part 8 section");
    let listed: Vec<&str> = section
        .lines()
        .filter_map(|l| l.strip_prefix("| `"))
        .filter_map(|l| l.split('`').next())
        .collect();
    let mut want: Vec<&str> = RingCode::ALL.iter().map(|c| c.as_str()).collect();
    let mut got = listed.clone();
    want.sort();
    got.sort();
    assert_eq!(got, want, "report table and RingCode enum differ");
}

#[test]
fn wav_header_rules() {
    let good = wav(16000);
    assert_eq!(wav_duration(&good[..44], good.len() as u64, 120_000), Ok(1000));
    let mut bad = good.clone();
    bad[0] = b'X';
    assert_eq!(wav_duration(&bad[..44], bad.len() as u64, 120_000), Err(Invalid(400)));
    let mut stereo = good.clone();
    stereo[22] = 2;
    assert_eq!(wav_duration(&stereo[..44], stereo.len() as u64, 120_000), Err(Invalid(400)));
    let mut size = good.clone();
    size[40] ^= 1;
    assert_eq!(wav_duration(&size[..44], size.len() as u64, 120_000), Err(Invalid(400)));
    assert_eq!(wav_duration(&good[..43], good.len() as u64, 120_000), Err(Invalid(400)));
    assert_eq!(wav_duration(&good[..44], good.len() as u64, 999), Err(Invalid(413)));
}

#[test]
fn manifest_limits_and_identity() {
    let meeting = json!({"intent": "meeting"});
    let ok = parse_upload(&manifest(44 + 32_000, meeting.clone(), "1234567890_abc")).unwrap();
    assert_eq!(ok.duration_ms, 1000);
    assert_eq!(ok.fingerprint.len(), 64);
    assert_eq!(ok.fingerprint, parse_upload(&manifest(44 + 32_000, meeting.clone(), "1234567890_abc")).unwrap().fingerprint);
    assert_ne!(ok.fingerprint, parse_upload(&manifest(44 + 64_000, meeting.clone(), "1234567890_abc")).unwrap().fingerprint);
    // Over the meeting duration limit is 413, a non-multiple of 32 bytes is 400.
    assert_eq!(parse_upload(&manifest(44 + 32 * 7_200_001, meeting.clone(), "1234567890_abc")), Err(Invalid(413)));
    assert_eq!(parse_upload(&manifest(44 + 33, meeting.clone(), "1234567890_abc")), Err(Invalid(400)));
    assert_eq!(parse_upload(&manifest(WAV_MAX + 1, meeting.clone(), "1234567890_abc")), Err(Invalid(413)));
    assert_eq!(parse_upload(&manifest(44 + 32_000, meeting.clone(), "bad id")), Err(Invalid(400)));
    let mut extra = manifest(44 + 32_000, meeting.clone(), "1234567890_abc");
    extra["extra"] = json!(1);
    assert_eq!(parse_upload(&extra), Err(Invalid(400)));
    // A voice request needs an amsg_ id and ends at 120 seconds.
    let voice = json!({"intent": "voice-request", "enablementId": ENABLEMENT, "capturedAt": null});
    assert!(parse_upload(&manifest(44 + 32_000, voice.clone(), "amsg_1234567890_abc")).unwrap().voice_mode);
    assert_eq!(parse_upload(&manifest(44 + 32_000, voice.clone(), "1234567890_abc")), Err(Invalid(400)));
    assert_eq!(parse_upload(&manifest(44 + 32 * 120_001, voice, "amsg_1234567890_abc")), Err(Invalid(413)));
}

#[test]
fn chunk_range_rules() {
    assert_eq!(chunk_index("0"), Some(0));
    assert_eq!(chunk_index("999"), Some(999));
    for bad in ["", "01", "1000", "-1", "1.5", "a"] {
        assert_eq!(chunk_index(bad), None, "{bad}");
    }
    assert_eq!(chunk_length(CHUNK * 2 + 5, 2), Ok(5));
    assert_eq!(chunk_length(CHUNK * 2 + 5, 0), Ok(CHUNK));
    assert_eq!(chunk_length(CHUNK * 2, 2), Err(Invalid(400)));
}

#[test]
fn packet_framing() {
    let mut v = PacketValidator::default();
    v.push(&[0, 2, 9, 9, 1, 1]).unwrap();
    v.push(&[7]).unwrap();
    assert_eq!(v.finish(), Ok(2));
    let mut skip = PacketValidator::default();
    assert!(skip.push(&[0, 1, 5, 2, 1, 5]).is_err());
    let mut zero = PacketValidator::default();
    assert!(zero.push(&[0, 0]).is_err());
    let mut cut = PacketValidator::default();
    cut.push(&[0, 3, 1]).unwrap();
    assert!(cut.finish().is_err());
    assert!(PacketValidator::default().finish().is_err());
}

#[test]
fn sidecar_reading() {
    let text = br#"{"record":["1700000000","start"]},{"btn":["1700000001","1"]},{"btn":["1700000500000","1"]},{"duration":["1700000002","4000"]},{"record":["1700000004","end"]}"#;
    let s = sidecar_metadata(text, 4000, SIDECAR_MAX, SIDECAR_MAX).unwrap();
    assert_eq!((s.start_ms, s.end_ms, s.recorded_duration_ms), (1_700_000_000_000, 1_700_000_004_000, 4000));
    assert_eq!(s.bookmarks_ms, vec![1000]);
    assert!(sidecar_metadata(b"", 1, SIDECAR_MAX, 9).is_err());
    assert!(sidecar_metadata(br#"{"record":["1","start"]}"#, 1, SIDECAR_MAX, 9).is_err());
    assert_eq!(sidecar_metadata(text, 4000, 5, 9), Err(Invalid(413)));
    assert!(sidecar_metadata(&[0xff], 1, SIDECAR_MAX, 9).is_err());
}

#[test]
fn voice_rules() {
    let inv = vec!["amsg_1234567890_a".to_owned(), "amsg_1234567890_b".to_owned()];
    let on = Enablement { enabled: true, inventory: &inv };
    assert_eq!(admit(Some(&on), "amsg_1234567890_c"), Ok(()));
    assert_eq!(admit(Some(&on), "amsg_1234567890_b"), Err(INELIGIBLE_BASELINE));
    assert_eq!(admit(Some(&Enablement { enabled: false, inventory: &inv }), "x"), Err(INELIGIBLE_DISABLED));
    assert_eq!(admit(None, "x"), Err(INELIGIBLE_DISABLED));
    assert!(automatic(Some(2000), 1000, 3000, 2500, 2900));
    assert!(!automatic(Some(900), 1000, 3000, 900, 2900));
    assert!(!automatic(Some(2000), 1000, 3000, 4000, 2900));
    assert!(!automatic(Some(2000), 1000, 3000, 2000, 3500));
    assert!(!automatic(None, 1000, 3000, 2000, 2500));
    let now = 10_000_000;
    assert_eq!(hand_off_state(false, true, Some(now), now), State::NoSpeech);
    assert_eq!(hand_off_state(true, true, Some(now - 1000), now), State::Queued);
    assert_eq!(hand_off_state(true, false, Some(now - 1000), now), State::ReadyToSend);
    assert_eq!(hand_off_state(true, true, Some(now - AUTOMATIC_MAX_AGE_MS - 1), now), State::ReadyToSend);
    assert_eq!(hand_off_state(true, true, Some(now + 1), now), State::ReadyToSend);
    assert_eq!(hand_off_state(true, true, None, now), State::ReadyToSend);
}

#[test]
fn enablement_request() {
    let ok = json!({"version": 2, "sourceDeviceId": DEVICE, "requestKey": "k", "recordingIds": ["amsg_1234567890_b", "amsg_1234567890_a"]});
    let (_, _, list) = parse_enablement(&ok).unwrap();
    assert_eq!(list, vec!["amsg_1234567890_a", "amsg_1234567890_b"]);
    let dup = json!({"version": 2, "sourceDeviceId": DEVICE, "requestKey": "k", "recordingIds": ["amsg_1234567890_a", "amsg_1234567890_a"]});
    assert!(parse_enablement(&dup).is_none());
    let bad = json!({"version": 2, "sourceDeviceId": DEVICE, "requestKey": "k", "recordingIds": ["nope"]});
    assert!(parse_enablement(&bad).is_none());
}
