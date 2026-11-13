//! Error codes the Mac link returns. The part 9 section of the meetings report lists the same
//! codes, and a test fails when the report and this enum differ.
use moss_module_sdk::Response;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureCode {
    Busy,
    Conflict,
    Limit,
    ProcessingUnavailable,
    SourceUnavailable,
    Unavailable,
    RateLimited,
    InvalidInput,
    Interrupted,
    RelinkRequired,
    ConnectionUnavailable,
}

impl CaptureCode {
    pub const ALL: [CaptureCode; 11] = [
        CaptureCode::Busy,
        CaptureCode::Conflict,
        CaptureCode::Limit,
        CaptureCode::ProcessingUnavailable,
        CaptureCode::SourceUnavailable,
        CaptureCode::Unavailable,
        CaptureCode::RateLimited,
        CaptureCode::InvalidInput,
        CaptureCode::Interrupted,
        CaptureCode::RelinkRequired,
        CaptureCode::ConnectionUnavailable,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CaptureCode::Busy => "meeting_capture_busy",
            CaptureCode::Conflict => "meeting_capture_conflict",
            CaptureCode::Limit => "meeting_capture_limit",
            CaptureCode::ProcessingUnavailable => "meeting_capture_processing_unavailable",
            CaptureCode::SourceUnavailable => "meeting_capture_source_unavailable",
            CaptureCode::Unavailable => "meeting_capture_unavailable",
            CaptureCode::RateLimited => "meeting_capture_rate_limited",
            CaptureCode::InvalidInput => "meeting_capture_invalid_input",
            CaptureCode::Interrupted => "meeting_capture_interrupted",
            CaptureCode::RelinkRequired => "recording_relink_required",
            CaptureCode::ConnectionUnavailable => "recording_connection_unavailable",
        }
    }

    /// The status the legacy route used for this code. `Unavailable` also answers 401 or 404,
    /// so callers that need those build the failure with `Failure::new`.
    pub fn status(self) -> u16 {
        match self {
            CaptureCode::Busy | CaptureCode::Conflict | CaptureCode::SourceUnavailable | CaptureCode::Interrupted => 409,
            CaptureCode::Limit => 413,
            CaptureCode::ProcessingUnavailable | CaptureCode::Unavailable => 503,
            CaptureCode::RateLimited => 429,
            CaptureCode::InvalidInput => 400,
            CaptureCode::RelinkRequired => 410,
            CaptureCode::ConnectionUnavailable => 401,
        }
    }
}

/// A refused capture request: a code, its status and an optional retry delay in seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: CaptureCode,
    pub status: u16,
    pub retry_after: Option<u64>,
}

impl Failure {
    pub fn new(code: CaptureCode) -> Self {
        Self { code, status: code.status(), retry_after: None }
    }

    pub fn with_status(code: CaptureCode, status: u16) -> Self {
        Self { code, status, retry_after: None }
    }

    pub fn rate_limited(seconds: u64) -> Self {
        Self { code: CaptureCode::RateLimited, status: 429, retry_after: Some(seconds) }
    }

    /// The body carries only the code. Meeting text never appears in a failure.
    pub fn body(&self) -> Value {
        match self.retry_after {
            Some(seconds) => json!({"code": self.code.as_str(), "retryAfterSeconds": seconds}),
            None => json!({"code": self.code.as_str()}),
        }
    }

    pub fn response(&self) -> Response {
        Response::new(self.status, self.body())
    }
}

/// Either a refusal to show the caller or a host fault. Routes map a fault to 503.
#[derive(Debug)]
pub enum Stop {
    Fail(Failure),
    Host(moss_module_sdk::Error),
}

impl From<Failure> for Stop {
    fn from(failure: Failure) -> Self {
        Stop::Fail(failure)
    }
}

impl From<moss_module_sdk::Error> for Stop {
    fn from(error: moss_module_sdk::Error) -> Self {
        Stop::Host(error)
    }
}

impl From<serde_json::Error> for Stop {
    fn from(error: serde_json::Error) -> Self {
        Stop::Host(error.into())
    }
}

/// Turns a stop into the response the legacy routes sent. A fault never carries detail.
pub fn respond(result: Result<Response, Stop>) -> Response {
    match result {
        Ok(response) => response,
        Err(Stop::Fail(failure)) => failure.response(),
        Err(Stop::Host(_)) => Failure::new(CaptureCode::Unavailable).response(),
    }
}
