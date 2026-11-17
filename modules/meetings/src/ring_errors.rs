//! Error codes the ring receivers return. The part 8 section of the meetings report lists the
//! same codes, and a test fails when the report and this enum differ.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RingCode {
    ImportConflict,
    ImportInvalid,
    ImportNotFound,
    VoiceIneligible,
    VoiceNotFound,
    TranscriptionUnavailable,
    TranscriptionFailed,
    ImportInterrupted,
    ImportUnavailable,
}

impl RingCode {
    pub const ALL: [RingCode; 9] = [
        RingCode::ImportConflict,
        RingCode::ImportInvalid,
        RingCode::ImportNotFound,
        RingCode::VoiceIneligible,
        RingCode::VoiceNotFound,
        RingCode::TranscriptionUnavailable,
        RingCode::TranscriptionFailed,
        RingCode::ImportInterrupted,
        RingCode::ImportUnavailable,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RingCode::ImportConflict => "recording_import_conflict",
            RingCode::ImportInvalid => "recording_import_invalid",
            RingCode::ImportNotFound => "recording_import_not_found",
            RingCode::VoiceIneligible => "recording_voice_ineligible",
            RingCode::VoiceNotFound => "recording_voice_not_found",
            RingCode::TranscriptionUnavailable => "transcription_unavailable",
            RingCode::TranscriptionFailed => "transcription_failed",
            RingCode::ImportInterrupted => "import_interrupted",
            RingCode::ImportUnavailable => "import_unavailable",
        }
    }
}

/// A refused upload. `status` is 413 for a size or duration over the limit and 400 otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invalid(pub u16);

pub const BAD: Invalid = Invalid(400);
pub const TOO_BIG: Invalid = Invalid(413);
