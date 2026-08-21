//! Workspace persistence: the open tab/pane layout as an opaque JSON blob
//! in ~/.r-console/workspace.json (see paths.rs).
//!
//! The schema is owned by the frontend; the backend just stores the string.
//! Like sessions.json, secrets never land here — SSH panes are persisted as
//! connection descriptors and re-resolved against the vault on restore.

use std::path::PathBuf;

fn workspace_path() -> Result<PathBuf, String> {
    Ok(crate::paths::data_dir()?.join("workspace.json"))
}

#[tauri::command]
pub fn workspace_save(snapshot: String) -> Result<(), String> {
    let path = workspace_path()?;
    std::fs::write(&path, snapshot).map_err(|e| format!("Failed to write workspace: {e}"))
}

#[tauri::command]
pub fn workspace_load() -> Result<Option<String>, String> {
    let path = workspace_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read workspace: {e}"))?;
    Ok(Some(text))
}
