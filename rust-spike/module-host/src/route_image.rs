//! Pictures a module route returns. The shell sends them as the response body, so it checks
//! the type, the size and the first bytes itself rather than trusting the package.
use base64::{engine::general_purpose::STANDARD, Engine};

/// Largest picture the shell will send. The 1 MiB host message limit applies first, because
/// the picture crosses as base64 inside a JSON reply.
pub const MAX_IMAGE_BYTES: usize = 786_432;
/// Longest time a browser may keep a picture, in seconds.
pub const MAX_AGE_LIMIT: u32 = 86_400;

fn matches_type(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/x-icon" => bytes.starts_with(&[0, 0, 1, 0]),
        _ => false,
    }
}

/// The picture's bytes, or `None` when the type is not an allowed picture type, the data is
/// not base64, it is too large, or its first bytes do not match its type.
pub fn decode(content_type: &str, base64: &str) -> Option<Vec<u8>> {
    if base64.len() > MAX_IMAGE_BYTES / 3 * 4 + 4 {
        return None;
    }
    let bytes = STANDARD.decode(base64).ok()?;
    (!bytes.is_empty() && bytes.len() <= MAX_IMAGE_BYTES && matches_type(content_type, &bytes)).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    #[test]
    fn a_matching_picture_decodes() {
        assert_eq!(decode("image/png", &b64(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1])).unwrap().len(), 9);
        assert!(decode("image/gif", &b64(b"GIF89a....")).is_some());
        assert!(decode("image/x-icon", &b64(&[0, 0, 1, 0, 9])).is_some());
    }

    #[test]
    fn a_type_that_does_not_match_its_bytes_is_refused() {
        assert!(decode("image/png", &b64(b"GIF89a....")).is_none());
        assert!(decode("text/html", &b64(b"<html>")).is_none());
        assert!(decode("image/svg+xml", &b64(b"<svg/>")).is_none());
    }

    #[test]
    fn bad_base64_and_oversize_pictures_are_refused() {
        assert!(decode("image/gif", "!!!").is_none());
        assert!(decode("image/gif", "").is_none());
        let mut big = b"GIF89a".to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(decode("image/gif", &b64(&big)).is_none());
    }
}
