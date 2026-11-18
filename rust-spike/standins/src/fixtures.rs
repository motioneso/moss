//! Fixture files compiled into the crate. All data is invented.

pub const TOKEN_AUTHORIZATION_CODE: &str = include_str!("../fixtures/google/token_authorization_code.json");
pub const TOKEN_REFRESH: &str = include_str!("../fixtures/google/token_refresh.json");
pub const ERROR_TOKEN_REVOKED: &str = include_str!("../fixtures/google/error_token_revoked.json");
pub const ERROR_TOKEN_BAD_CODE: &str = include_str!("../fixtures/google/error_token_bad_code.json");
pub const ERROR_TOKEN_BAD_CLIENT: &str = include_str!("../fixtures/google/error_token_bad_client.json");
pub const ERROR_UNSUPPORTED_GRANT: &str = include_str!("../fixtures/google/error_unsupported_grant.json");
pub const ERROR_401: &str = include_str!("../fixtures/google/error_401.json");
pub const ERROR_429: &str = include_str!("../fixtures/google/error_429.json");
pub const ERROR_404: &str = include_str!("../fixtures/google/error_404.json");
pub const ERROR_410_DELETED: &str = include_str!("../fixtures/google/error_410_deleted.json");
pub const ERROR_400_INVALID_RAW: &str = include_str!("../fixtures/google/error_400_invalid_raw.json");
pub const GMAIL_MESSAGE_FULL: &str = include_str!("../fixtures/google/gmail_message_full.json");
pub const GMAIL_MESSAGE_LIST: &str = include_str!("../fixtures/google/gmail_message_list.json");
pub const GMAIL_HISTORY: &str = include_str!("../fixtures/google/gmail_history.json");
pub const GMAIL_SEND_RESPONSE: &str = include_str!("../fixtures/google/gmail_send_response.json");
pub const CALENDAR_EVENT: &str = include_str!("../fixtures/google/calendar_event.json");
pub const CALENDAR_EVENTS_LIST: &str = include_str!("../fixtures/google/calendar_events_list.json");
pub const CALENDAR_LIST: &str = include_str!("../fixtures/google/calendar_list.json");

pub const MAIL_AGENDA: &str = include_str!("../fixtures/mail/agenda.eml");
pub const MAIL_LUNCH: &str = include_str!("../fixtures/mail/lunch.eml");
pub const MAIL_INVOICE: &str = include_str!("../fixtures/mail/invoice.eml");

/// Fills `{{NAME}}` markers in a fixture.
pub fn fill(template: &str, pairs: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (k, v) in pairs {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}
