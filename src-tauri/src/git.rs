//! Git integration for the sidebar Git panel. Runs the `git` CLI as a
//! one-shot command — over an SSH exec channel for remote sessions (same
//! mechanism as sysmon) or via a local child process for local sessions —
//! so local and remote repos share one code path and no git2 dependency or
//! remote agent beyond a git binary is needed.

use crate::session::{get_conn, SharedSessionManager};
use serde::Serialize;
use tauri::State;

/// Largest file content pulled into the diff viewer.
const MAX_CONTENT_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    /// Original path for renamed/copied entries.
    pub orig_path: Option<String>,
    /// Index (staged) status letter: M/A/D/R/C/U, "." when unchanged, "?"
    /// for untracked files.
    pub staged_state: String,
    /// Worktree (unstaged) status letter, "." when unchanged.
    pub unstaged_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// False when `cwd` is not inside a git repository (not an error).
    pub is_repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitStatusEntry>,
}

struct CmdOutput {
    status: Option<i64>,
    /// stdout and stderr combined (in arrival order for SSH).
    output: String,
}

/// Single-quote a string for safe embedding in a POSIX shell command line.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run `git <args>` in `cwd`, over the SSH exec channel when `conn_key` is
/// set, else as a local child process. When `cwd` is unknown the command
/// falls back to the session home (SSH exec starts there; locally the HOME
/// environment variable is used).
async fn run_git(
    state: &State<'_, SharedSessionManager>,
    conn_key: Option<&str>,
    cwd: Option<&str>,
    args: &[&str],
) -> Result<CmdOutput, String> {
    match conn_key {
        Some(key) => {
            let conn = get_conn(state, key)?;
            let quoted = args
                .iter()
                .map(|a| sh_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            let cmd = match cwd {
                Some(dir) => format!("cd {} && git {}", sh_quote(dir), quoted),
                None => format!("git {quoted}"),
            };
            let (output, status) = conn.exec_full(&cmd).await?;
            Ok(CmdOutput {
                status: status.map(i64::from),
                output,
            })
        }
        None => {
            let mut cmd = tokio::process::Command::new("git");
            cmd.args(args).kill_on_drop(true);
            match cwd {
                Some(dir) => {
                    cmd.current_dir(dir);
                }
                None => {
                    if let Some(home) = std::env::var_os("HOME")
                        .or_else(|| std::env::var_os("USERPROFILE"))
                    {
                        cmd.current_dir(home);
                    }
                }
            }
            // Local git runs on the transfer pool: `git status` on a large
            // repo can take seconds and must not stall command dispatch.
            let out = crate::runtime::run_bulk(async move {
                cmd.output()
                    .await
                    .map_err(|e| format!("Failed to run git: {e}"))
            })
            .await?;
            let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
            output.push_str(&String::from_utf8_lossy(&out.stderr));
            Ok(CmdOutput {
                status: out.status.code().map(i64::from),
                output,
            })
        }
    }
}

fn ensure_success(out: &CmdOutput, what: &str) -> Result<(), String> {
    if out.status == Some(0) {
        Ok(())
    } else {
        Err(format!("{what} failed: {}", out.output.trim()))
    }
}

/// Parse `git status --porcelain=v2 --branch -z` output. With `-z`, records
/// (including branch headers) are NUL-terminated and paths are unquoted;
/// rename entries place the original path in the following record.
fn parse_status(raw: &str) -> GitStatus {
    let mut branch = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();
    let mut records = raw.split('\0');
    while let Some(rec) = records.next() {
        if let Some(rest) = rec.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = rec.strip_prefix("# branch.ab ") {
            for tok in rest.split_whitespace() {
                if let Some(a) = tok.strip_prefix('+') {
                    ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = tok.strip_prefix('-') {
                    behind = b.parse().unwrap_or(0);
                }
            }
        } else if let Some(path) = rec.strip_prefix("? ") {
            entries.push(GitStatusEntry {
                path: path.to_string(),
                orig_path: None,
                staged_state: "?".to_string(),
                unstaged_state: ".".to_string(),
            });
        } else if rec.starts_with("1 ") || rec.starts_with("2 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
            let renamed = rec.starts_with("2 ");
            let fields: Vec<&str> = rec.splitn(if renamed { 11 } else { 10 }, ' ').collect();
            let xy = fields.get(1).copied().unwrap_or("..");
            let mut xy = xy.chars();
            let staged = xy.next().unwrap_or('.');
            let unstaged = xy.next().unwrap_or('.');
            let path = fields.last().copied().unwrap_or("").to_string();
            let orig_path = renamed.then(|| records.next().unwrap_or("").to_string());
            entries.push(GitStatusEntry {
                path,
                orig_path,
                staged_state: staged.to_string(),
                unstaged_state: unstaged.to_string(),
            });
        }
        // "u " (unmerged), "! " (ignored) and other header lines are skipped.
    }
    GitStatus {
        is_repo: true,
        branch,
        ahead,
        behind,
        entries,
    }
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, SharedSessionManager>,
    conn_key: Option<String>,
    cwd: Option<String>,
) -> Result<GitStatus, String> {
    let out = run_git(
        &state,
        conn_key.as_deref(),
        cwd.as_deref(),
        &["status", "--porcelain=v2", "--branch", "-z"],
    )
    .await?;
    if out.status != Some(0) {
        // Exit 128 / "not a git repository" is an expected state, not an
        // error: the panel shows a hint instead of failing.
        return Ok(GitStatus {
            is_repo: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            entries: Vec::new(),
        });
    }
    Ok(parse_status(&out.output))
}

/// Unified diff text for one file (`--cached` when `staged`).
#[tauri::command]
pub async fn git_diff(
    state: State<'_, SharedSessionManager>,
    conn_key: Option<String>,
    cwd: Option<String>,
    path: String,
    staged: bool,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path.as_str()]);
    let out = run_git(&state, conn_key.as_deref(), cwd.as_deref(), &args).await?;
    ensure_success(&out, "git diff")?;
    Ok(out.output)
}

/// File content for the diff viewer. `source` selects the HEAD version, the
/// index (staged) version, or the worktree file. Missing HEAD/index versions
/// (new or untracked files) yield an empty string.
#[tauri::command]
pub async fn git_file_content(
    state: State<'_, SharedSessionManager>,
    conn_key: Option<String>,
    cwd: Option<String>,
    path: String,
    source: String,
) -> Result<String, String> {
    let bytes = match source.as_str() {
        "head" | "index" => {
            let spec = if source == "head" {
                format!("HEAD:{path}")
            } else {
                format!(":{path}")
            };
            let out = run_git(
                &state,
                conn_key.as_deref(),
                cwd.as_deref(),
                &["show", &spec],
            )
            .await?;
            if out.status != Some(0) {
                return Ok(String::new());
            }
            out.output.into_bytes()
        }
        "worktree" => match conn_key.as_deref() {
            Some(key) => {
                let conn = get_conn(&state, key)?;
                let cmd = match cwd.as_deref() {
                    Some(dir) => format!(
                        "cd {} && head -c {} -- {}",
                        sh_quote(dir),
                        MAX_CONTENT_BYTES,
                        sh_quote(&path)
                    ),
                    None => format!("head -c {} -- {}", MAX_CONTENT_BYTES, sh_quote(&path)),
                };
                conn.exec(&cmd).await?.into_bytes()
            }
            None => {
                use tokio::io::AsyncReadExt;
                let base = match cwd.as_deref() {
                    Some(dir) => std::path::PathBuf::from(dir),
                    None => std::env::var_os("HOME")
                        .or_else(|| std::env::var_os("USERPROFILE"))
                        .map(std::path::PathBuf::from)
                        .ok_or("Cannot resolve the working directory")?,
                };
                let file = tokio::fs::File::open(base.join(&path))
                    .await
                    .map_err(|e| format!("Failed to open file: {e}"))?;
                let mut buf = Vec::new();
                file.take(MAX_CONTENT_BYTES)
                    .read_to_end(&mut buf)
                    .await
                    .map_err(|e| format!("Failed to read file: {e}"))?;
                buf
            }
        },
        _ => return Err(format!("Unknown content source: {source}")),
    };
    if bytes.contains(&0) {
        return Err("Binary file: diff view is not supported".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, SharedSessionManager>,
    conn_key: Option<String>,
    cwd: Option<String>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    let out = run_git(&state, conn_key.as_deref(), cwd.as_deref(), &args).await?;
    ensure_success(&out, "git add")
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, SharedSessionManager>,
    conn_key: Option<String>,
    cwd: Option<String>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    let out = run_git(&state, conn_key.as_deref(), cwd.as_deref(), &args).await?;
    if out.status == Some(0) {
        return Ok(());
    }
    // `git restore` needs git >= 2.23; fall back to `git reset` for older
    // versions on the remote host.
    let mut fallback: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
    fallback.extend(paths.iter().map(String::as_str));
    let out = run_git(&state, conn_key.as_deref(), cwd.as_deref(), &fallback).await?;
    ensure_success(&out, "git unstage")
}

/// Commit staged changes; returns git's own summary output.
#[tauri::command]
pub async fn git_commit(
    state: State<'_, SharedSessionManager>,
    conn_key: Option<String>,
    cwd: Option<String>,
    message: String,
) -> Result<String, String> {
    let out = run_git(
        &state,
        conn_key.as_deref(),
        cwd.as_deref(),
        &["commit", "-m", &message],
    )
    .await?;
    ensure_success(&out, "git commit")?;
    Ok(out.output)
}
