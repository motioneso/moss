//! OS file choice for the selected-archive restore entry point.
use std::path::PathBuf;

#[cfg(target_os = "linux")]
pub fn choose() -> Option<PathBuf> {
    use gtk::prelude::*;
    let dialog = gtk::FileChooserDialog::new(
        Some("Choose a Moss backup"),
        None::<&gtk::Window>,
        gtk::FileChooserAction::Open,
    );
    dialog.add_buttons(&[
        ("Cancel", gtk::ResponseType::Cancel),
        ("Choose file", gtk::ResponseType::Accept),
    ]);
    let filter = gtk::FileFilter::new();
    filter.set_name(Some("Moss backups"));
    filter.add_pattern("*.mossbak");
    dialog.add_filter(filter);
    let selected = (dialog.run() == gtk::ResponseType::Accept)
        .then(|| dialog.filename())
        .flatten();
    dialog.close();
    selected
}

#[cfg(any(target_os = "macos", windows))]
pub fn choose() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("osascript")
        .args([
            "-e",
            "POSIX path of (choose file with prompt \"Choose a Moss backup\")",
        ])
        .output()
        .ok()?;
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("powershell.exe").creation_flags(0x0800_0000)
            .args(["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='Moss backups (*.mossbak)|*.mossbak'; if($d.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.FileName}"])
            .output().ok()?
    };
    if !result.status.success() {
        return None;
    }
    let text = String::from_utf8(result.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.into())
}
