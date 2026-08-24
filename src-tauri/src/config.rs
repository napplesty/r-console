//! Session configuration persistence: the saved SSH session list as JSON
//! in ~/.r-console/sessions.json (see paths.rs).
//!
//! Security convention: passwords and key passphrases are never written to
//! disk; the file only holds connection metadata.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key"
    pub auth_kind: String,
    pub key_path: Option<String>,
    /// Run the shell inside a persistent tmux session (survives disconnects).
    #[serde(default = "default_persistent")]
    pub persistent: bool,
}

fn default_persistent() -> bool {
    true
}

fn store_path() -> Result<PathBuf, String> {
    Ok(crate::paths::data_dir()?.join("sessions.json"))
}

fn read_all() -> Result<Vec<SavedSession>, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse config: {e}"))
}

fn write_all(sessions: &[SavedSession]) -> Result<(), String> {
    let path = store_path()?;
    let text = serde_json::to_string_pretty(sessions).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Failed to write config: {e}"))
}

#[tauri::command]
pub fn saved_sessions_list() -> Result<Vec<SavedSession>, String> {
    let all = read_all()?;
    // Clean up duplicates accumulated before endpoint-based dedup: one entry
    // per host+port+username, keeping the last occurrence in the file.
    let mut seen = std::collections::HashSet::new();
    let mut deduped: Vec<SavedSession> = all
        .iter()
        .rev()
        .filter(|s| seen.insert((s.host.clone(), s.port, s.username.clone())))
        .cloned()
        .collect();
    deduped.reverse();
    if deduped.len() != all.len() {
        write_all(&deduped)?;
    }
    Ok(deduped)
}

#[tauri::command]
pub fn saved_sessions_save(session: SavedSession) -> Result<(), String> {
    let mut all = read_all()?;
    // One entry per endpoint: drop stale duplicates of the same
    // host/port/username saved under a different id.
    all.retain(|s| {
        s.id == session.id
            || s.host != session.host
            || s.port != session.port
            || s.username != session.username
    });
    match all.iter_mut().find(|s| s.id == session.id) {
        Some(existing) => *existing = session,
        None => all.push(session),
    }
    write_all(&all)
}

#[tauri::command]
pub fn saved_sessions_delete(id: String) -> Result<(), String> {
    let mut all = read_all()?;
    all.retain(|s| s.id != id);
    write_all(&all)
}
