//! Reporting at real installer boundaries. Errors expose only fixed public messages.
use std::fmt;
#[derive(Clone, Copy, Debug)]
pub enum InstallStage {
    Downloading,
    Verifying,
    SettingUpData,
    Activating,
}
#[derive(Clone, Copy, Debug)]
pub enum InstallFailure {
    Download,
    Verification,
    Sql,
}
impl InstallFailure {
    pub fn message(self) -> &'static str {
        match self {
            Self::Download => "The package could not be downloaded.",
            Self::Verification => "The package signature or contents could not be verified.",
            Self::Sql => "The module data could not be set up.",
        }
    }
}
impl fmt::Display for InstallFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for InstallFailure {}
pub type Progress<'a> = &'a dyn Fn(InstallStage) -> anyhow::Result<()>;
