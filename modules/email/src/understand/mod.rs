//! Email understanding. Pure rules and prompt building live here; the host store does
//! the SQL and the host AI port answers the model calls.
pub mod extract;
pub mod gate;
pub mod otp;
pub mod pass;
pub mod prompt;
pub mod sorting;
pub mod text;
