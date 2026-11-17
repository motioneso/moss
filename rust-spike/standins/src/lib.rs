//! Local stand-ins for Google, IMAP, SMTP, Plaid and invented Wellness data, used only by tests.
//!
//! Nothing here talks to a real provider. Replies copy the shapes the real services send, taken
//! from the fixtures in `fixtures/` (invented names, example.com addresses only).

pub mod fixtures;
pub mod google;
pub mod imap;
pub mod mail;
pub mod outlook;
pub mod plaid;
pub mod smtp;
pub mod tls;
pub mod wellness;
