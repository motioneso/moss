/// Stable per-data-folder login identity; separate portable installs never overwrite each other.
pub fn install_id(data: &std::path::Path) -> u64 {
    data.as_os_str()
        .as_encoded_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
        })
}

/// Commands a native tray can send to the window thread.
pub enum Action {
    Reveal,
    Settings,
    Unavailable,
}
