//! A least-privilege task triggered only by this owner's interactive logon.
use super::{windows_arg, xml, REMEDY};
use std::path::Path;
use std::process::Command;

pub(super) fn definition(launcher: &Path, folder: &Path) -> Result<Vec<u8>, String> {
    let output = Command::new("whoami.exe")
        .args(["/USER", "/FO", "CSV", "/NH"])
        .output()
        .map_err(|_| REMEDY)?;
    if !output.status.success() {
        return Err(REMEDY.into());
    }
    let identity = String::from_utf8_lossy(&output.stdout);
    // The SID is the last CSV column, independently of punctuation in the account name.
    let sid = identity
        .rsplit(',')
        .next()
        .ok_or(REMEDY)?
        .trim()
        .trim_matches('"');
    if !sid.starts_with("S-1-")
        || !sid
            .bytes()
            .all(|b| b.is_ascii_digit() || b"S-".contains(&b))
    {
        return Err(REMEDY.into());
    }
    let arguments = xml(&format!("service-run {}", windows_arg(folder)));
    let definition = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers><Principals><Principal id="Owner"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Owner"><Exec><Command>{}</Command><Arguments>{arguments}</Arguments></Exec></Actions></Task>"#,
        xml(&launcher.to_string_lossy())
    );
    // schtasks reads the XML file as UTF-16; a UTF-8 declaration is rejected by its parser.
    Ok([0xff, 0xfe]
        .into_iter()
        .chain(definition.encode_utf16().flat_map(u16::to_le_bytes))
        .collect())
}
