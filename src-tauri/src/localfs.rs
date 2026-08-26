//! Local filesystem operations for the file panel. They mirror the SFTP
//! commands' shapes and error messages so one UI component (SftpPanel /
//! FileViewer) drives both local and SSH panes.

use crate::session::{parse_grep_hits, SftpDirListing, SshGrepHit};
use crate::ssh::SftpEntry;
use std::path::PathBuf;

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Expand a leading "~" to the home directory. Remote listings arrive
/// canonical from the server; local paths need this on first load.
fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

#[tauri::command]
pub async fn localfs_list_dir(path: String) -> Result<SftpDirListing, String> {
    let expanded = expand_home(&path);
    let canonical = tokio::fs::canonicalize(&expanded)
        .await
        .unwrap_or(expanded);
    let mut dir = tokio::fs::read_dir(&canonical)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?;
    let mut entries = Vec::new();
    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?
    {
        let meta = entry.metadata().await.ok();
        entries.push(SftpEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
            size: meta.as_ref().map(|m| m.len()),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(SftpDirListing {
        path: canonical.to_string_lossy().into_owned(),
        entries,
    })
}

/// Read a local text file for in-app preview, with the same caps and binary
/// rejection as the SFTP variant.
#[tauri::command]
pub async fn localfs_read_text(path: String) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    const MAX_PREVIEW_BYTES: u64 = 512 * 1024;

    let file = tokio::fs::File::open(expand_home(&path))
        .await
        .map_err(|e| format!("Failed to open file: {e}"))?;
    let mut buf = Vec::new();
    file.take(MAX_PREVIEW_BYTES)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    if buf.contains(&0) {
        return Err("Binary file: preview is not supported".to_string());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Overwrite a local text file with editor content; creates missing parents
/// so "new file" in an existing directory just works.
#[tauri::command]
pub async fn localfs_write_text(path: String, content: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let path = expand_home(&path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("Failed to open file for writing: {e}"))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write file: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to finalize file: {e}"))
}

#[tauri::command]
pub async fn localfs_rename(old_path: String, new_path: String) -> Result<(), String> {
    tokio::fs::rename(expand_home(&old_path), expand_home(&new_path))
        .await
        .map_err(|e| format!("Failed to rename: {e}"))
}

#[tauri::command]
pub async fn localfs_mkdir(path: String) -> Result<(), String> {
    tokio::fs::create_dir(expand_home(&path))
        .await
        .map_err(|e| format!("Failed to create directory: {e}"))
}

/// Delete a local file or directory (recursive, bottom-up) — same walk as
/// the SFTP variant. Runs on the transfer pool: recursive deletes can walk
/// arbitrarily large trees.
#[tauri::command]
pub async fn localfs_delete(path: String, is_dir: bool) -> Result<(), String> {
    crate::runtime::run_bulk(async move {
        let path = expand_home(&path);
        if !is_dir {
            return tokio::fs::remove_file(&path)
                .await
                .map_err(|e| format!("Failed to delete file: {e}"));
        }
        let mut dirs = vec![path];
        let mut files: Vec<PathBuf> = Vec::new();
        let mut idx = 0;
        while idx < dirs.len() {
            let mut dir = tokio::fs::read_dir(&dirs[idx])
                .await
                .map_err(|e| format!("Failed to read directory: {e}"))?;
            idx += 1;
            while let Some(entry) = dir
                .next_entry()
                .await
                .map_err(|e| format!("Failed to read directory: {e}"))?
            {
                // Symlinks are not followed: they are removed as files.
                let is_dir = entry
                    .file_type()
                    .await
                    .map(|t| t.is_dir())
                    .unwrap_or(false);
                if is_dir {
                    dirs.push(entry.path());
                } else {
                    files.push(entry.path());
                }
            }
        }
        for f in &files {
            tokio::fs::remove_file(f)
                .await
                .map_err(|e| format!("Failed to delete file {f:?}: {e}"))?;
        }
        for d in dirs.iter().rev() {
            tokio::fs::remove_dir(d)
                .await
                .map_err(|e| format!("Failed to delete directory {d:?}: {e}"))?;
        }
        Ok(())
    })
    .await
}

/// Content search in a local directory — the same grep invocation as
/// `ssh_grep`, run directly (no shell, no quoting) and capped at 200 hits.
/// Runs on the transfer pool: `grep -r` can scan for a long time.
#[tauri::command]
pub async fn localfs_grep(path: String, query: String) -> Result<Vec<SshGrepHit>, String> {
    crate::runtime::run_bulk(async move {
        let out = tokio::process::Command::new("grep")
            .args([
                "-rIn",
                "--binary-files=without-match",
                "--exclude-dir=.git",
                "-e",
            ])
            .arg(&query)
            .arg("--")
            .arg(expand_home(&path))
            .output()
            .await
            .map_err(|e| format!("Failed to run grep: {e}"))?;
        if !out.status.success() && !out.status.code().is_some_and(|c| c == 1) {
            // Exit 1 simply means "no matches".
            return Err(format!(
                "grep failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        Ok(parse_grep_hits(&stdout))
    })
    .await
}

/// Copy a local file (upload-into-directory and download-to-chosen-path both
/// reduce to this). Local disk copies are fast enough that the SFTP-style
/// progress events are not needed.
#[tauri::command]
pub async fn localfs_copy(from: String, to: String) -> Result<(), String> {
    crate::runtime::run_bulk(async move {
        let from = expand_home(&from);
        let to = expand_home(&to);
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        }
        tokio::fs::copy(&from, &to)
            .await
            .map_err(|e| format!("Failed to copy file: {e}"))?;
        Ok(())
    })
    .await
}
