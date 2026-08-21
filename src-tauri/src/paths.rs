//! The user-level data directory: `~/.r-console`.
//!
//! All app-owned state (saved sessions, workspace snapshot, credential
//! vault) lives here instead of the OS-specific app-config dir, so users
//! can find, back up, and version their data. On first run, files are
//! migrated from the legacy Tauri app-config dir. SSH known_hosts stays in
//! ~/.ssh on purpose (OpenSSH semantics).

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DIR_NAME: &str = ".r-console";
/// Files migrated from the legacy app-config dir on first run.
const MIGRATED_FILES: [&str; 3] = ["sessions.json", "workspace.json", "credentials.vault"];

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Failed to locate the home directory".to_string())
}

/// Path of the data directory, creating it on demand.
pub fn data_dir() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// One-time migration of files from the legacy Tauri app-config dir. Runs
/// at startup; copies only files that do not exist in the new location.
pub fn migrate_legacy_config(app: &AppHandle) {
    let Ok(legacy) = app.path().app_config_dir() else {
        return;
    };
    let Ok(new) = data_dir() else {
        return;
    };
    if legacy == new {
        return;
    }
    for name in MIGRATED_FILES {
        let from = legacy.join(name);
        let to = new.join(name);
        if from.exists() && !to.exists() {
            if let Err(e) = std::fs::copy(&from, &to) {
                eprintln!("Failed to migrate {}: {e}", from.display());
            }
        }
    }
}
