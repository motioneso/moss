//! Optional presentation is authenticated by the existing signed index, never a sidecar label.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    pub name: String,
    pub description: String,
    pub publisher: String,
    pub category: String,
    #[serde(default)]
    pub screenshots: Vec<Screenshot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Screenshot {
    /// Content-addressed registry media filename, e.g. <sha256>.png.
    pub file: String,
    pub caption: String,
}
impl Presentation {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.name.trim().is_empty()
                && self.name.len() <= 120
                && self.description.len() <= 1000
                && self.publisher.len() <= 120
                && self.category.len() <= 80
                && self.screenshots.len() <= 4,
            "Invalid catalog presentation"
        );
        for screenshot in &self.screenshots {
            let (digest, extension) = screenshot.file.rsplit_once('.').unwrap_or_default();
            ensure!(
                crate::trust::valid_digest(digest)
                    && matches!(extension, "png" | "jpg" | "webp")
                    && screenshot.caption.len() <= 200,
                "Invalid catalog screenshot"
            );
        }
        Ok(())
    }
}
