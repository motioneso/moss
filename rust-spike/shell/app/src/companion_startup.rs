//! Host schema preparation independent of the way Meetings was installed.
use safety_core::db::Database;
use std::path::Path;

pub async fn prepare(
    auth: &Database,
    modules: Option<&Path>,
    instance: Option<&Path>,
) -> Result<(), String> {
    let db = auth
        .auth_client()
        .await
        .map_err(|_| "Cannot check device lookup".to_owned())?;
    let ready: bool = db
        .query_one(
            "SELECT to_regclass('app.companion_recording_attempts') IS NOT NULL \
         AND to_regclass('app.companion_devices_owner') IS NULL",
            &[],
        )
        .await
        .map_err(|_| "Cannot check device lookup".to_owned())?
        .get(0);
    if !ready {
        return Ok(());
    }
    // An installed app asks its supervisor for the elevated login for this one step,
    // just as module installation does. The login is never saved in server settings.
    let url = if let Ok(url) = std::env::var(crate::module_install::INSTALL_URL_VARIABLE) {
        url
    } else if let Some(instance) = instance {
        let instance = instance.to_path_buf();
        tokio::task::spawn_blocking(move || crate::module_admin::elevated_url(&instance))
            .await
            .map_err(|_| "Cannot prepare device lookup".to_owned())?
            .map_err(str::to_owned)?
    } else if let Some(path) = modules {
        crate::modules::read_settings(path)
            .map_err(|_| "Cannot read module settings".to_owned())?
            .migrations_url
    } else {
        // A server with no module host cannot install Meetings. Its later configured start
        // will run this step; it must not acquire a new required environment variable.
        return Ok(());
    };
    crate::module_install::ensure_device_sql(&url)
        .await
        .map_err(|_| "Cannot prepare device lookup".to_owned())
}
