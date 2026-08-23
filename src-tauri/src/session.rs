//! Unified session management: local PTY and SSH terminals share the same
//! spawn / write / resize / close semantics.
//!
//! Frontend event protocol:
//!   - `session-data-{session_id}`: terminal output (String)
//!   - `session-exit-{session_id}`: session terminated

use crate::local_pty::LocalPty;
use crate::ssh::{SftpEntry, SshConnectConfig, SshConnection, SshShell};
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tokio::sync::mpsc;

enum SessionKind {
    Local(LocalPty),
    Ssh(SshShell),
}

/// Shell integration snippet sent right after a shell starts: installs
/// prompt hooks that report the working directory via OSC 7 (letting the
/// UI, e.g. the SFTP panel, follow the terminal) and command lifecycle
/// marks via OSC 133 (A prompt, B input, C executing, D done + exit code —
/// VS Code terminal semantics, used for gutter dots and command
/// navigation). Best-effort — unknown shells simply never report. Ends
/// with `clear` to hide the injected command.
///
/// Inside tmux, raw OSC sequences are swallowed by the multiplexer, so the
/// sequence is wrapped in a DCS passthrough (ESCs of the inner sequence
/// doubled). This requires `allow-passthrough on` on the tmux session,
/// which persistent sessions set at creation time.
pub(crate) const SHELL_INIT: &str = concat!(
    // Idempotency marker: a second injection (nested shell, re-source) is a no-op.
    "if [ -z \"$__rc_shell_integration\" ]; then __rc_shell_integration=1;",
    // Emit one OSC sequence; inside tmux wrap it in a DCS passthrough.
    "__rc_osc() { if [ -n \"$TMUX\" ]; then",
    " printf '\\033Ptmux;\\033\\033]%s\\007\\033\\\\' \"$1\";",
    " else printf '\\033]%s\\033\\\\' \"$1\"; fi; };",
    "__rc_osc7() { __rc_osc \"7;file://$(hostname)$PWD\"; };",
    // Runs at every prompt: report the previous command's exit code (if
    // any), then mark prompt start (A) and input start (B). `local ec=$?`
    // must be first — anything else would clobber the real exit code.
    "__rc_prompt() { local ec=$?;",
    " if [ -n \"$__rc_cmd\" ]; then __rc_osc \"133;D;$ec\"; __rc_cmd=; fi;",
    " __rc_osc7; __rc_osc \"133;A\"; __rc_osc \"133;B\"; };",
    // Runs between accepting a command and executing it (zsh preexec, bash PS0).
    "__rc_exec() { __rc_cmd=1; __rc_osc \"133;C\"; };",
    "case \"$0\" in",
    " *zsh) autoload -Uz add-zsh-hook",
    " && add-zsh-hook precmd __rc_prompt && add-zsh-hook preexec __rc_exec ;;",
    " *bash) PROMPT_COMMAND=\"__rc_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";",
    // PS0 expands like PS1; \[ \] mark the escape output as non-printing.
    " PS0='\\[$(__rc_exec)\\]'\"$PS0\" ;;",
    "esac; fi; clear\n",
);

#[derive(Default)]
pub struct SessionManager {
    sessions: HashMap<String, SessionKind>,
    /// Established SSH connections keyed by conn_key; multiple tabs
    /// multiplex over a single TCP connection.
    ssh_conns: HashMap<String, Arc<SshConnection>>,
    /// Long-lived tmux control channels keyed by conn_key: a single exec
    /// channel running a shell loop that executes one tmux command per
    /// stdin line, so high-frequency control traffic (wheel scrolling)
    /// avoids channel + remote shell setup per command.
    tmux_ctrl: HashMap<String, mpsc::Sender<String>>,
    next_id: u64,
}

pub type SharedSessionManager = Arc<Mutex<SessionManager>>;

impl SessionManager {
    fn alloc_id(&mut self) -> String {
        self.next_id += 1;
        format!("s-{}", self.next_id)
    }

    /// Remove a pooled connection only when it is still the same instance
    /// (a reconnect may already have replaced it).
    pub(crate) fn drop_connection_if(&mut self, conn_key: &str, conn: &Arc<SshConnection>) {
        if self
            .ssh_conns
            .get(conn_key)
            .is_some_and(|c| Arc::ptr_eq(c, conn))
        {
            self.ssh_conns.remove(conn_key);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionInfo {
    pub session_id: String,
    pub conn_key: String,
}

#[tauri::command]
pub fn session_spawn_local(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SharedSessionManager>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    let id = mgr.alloc_id();
    let pty = LocalPty::spawn(app, &id, cols, rows, window.label())?;
    mgr.sessions.insert(id.clone(), SessionKind::Local(pty));
    Ok(id)
}

#[tauri::command]
pub async fn session_spawn_ssh(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SharedSessionManager>,
    config: SshConnectConfig,
    cols: u16,
    rows: u16,
) -> Result<SshSessionInfo, String> {
    let conn_key = config.conn_key();
    let window_label = window.label().to_string();

    // Reuse an existing connection or establish a new one.
    // Never hold the manager lock across .await.
    let conn = {
        let mgr = state.lock().map_err(|e| e.to_string())?;
        mgr.ssh_conns.get(&conn_key).cloned()
    };
    let conn = match conn {
        Some(c) => c,
        None => {
            let c =
                Arc::new(SshConnection::connect(&config, app.clone(), window_label.clone()).await?);
            let mut mgr = state.lock().map_err(|e| e.to_string())?;
            mgr.ssh_conns.insert(conn_key.clone(), c.clone());
            c
        }
    };

    let session_id = {
        let mut mgr = state.lock().map_err(|e| e.to_string())?;
        mgr.alloc_id()
    };
    let shell = SshShell::open(
        conn,
        state.inner().clone(),
        conn_key.clone(),
        app,
        session_id.clone(),
        cols,
        rows,
        window_label,
        config.persistent,
        config.tmux_session.clone(),
    )
    .await?;

    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.sessions
        .insert(session_id.clone(), SessionKind::Ssh(shell));
    Ok(SshSessionInfo {
        session_id,
        conn_key,
    })
}

#[tauri::command]
pub fn session_write(
    state: State<'_, SharedSessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    match mgr.sessions.get(&session_id) {
        Some(SessionKind::Local(pty)) => pty.write(data.as_bytes()),
        Some(SessionKind::Ssh(shell)) => shell.write(data.as_bytes()),
        None => Err("Session not found".to_string()),
    }
}

#[tauri::command]
pub fn session_resize(
    state: State<'_, SharedSessionManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    match mgr.sessions.get(&session_id) {
        Some(SessionKind::Local(pty)) => pty.resize(cols, rows),
        Some(SessionKind::Ssh(shell)) => shell.resize(cols, rows),
        None => Err("Session not found".to_string()),
    }
}

#[tauri::command]
pub fn session_close(
    state: State<'_, SharedSessionManager>,
    session_id: String,
) -> Result<(), String> {
    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    match mgr.sessions.remove(&session_id) {
        Some(SessionKind::Local(mut pty)) => pty.kill(),
        // Dropping the sender ends the driver task, which closes the channel.
        Some(SessionKind::Ssh(shell)) => drop(shell),
        None => {}
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDirListing {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

/// Shell loop run on the control channel: one tmux command per stdin line.
/// Commands are fixed frontend templates built from validated session
/// names; `eval` re-parses the tmux-level `\;` separators.
const TMUX_CTRL_SCRIPT: &str =
    "while IFS= read -r line; do eval \"tmux $line\"; done";

/// Queue one tmux command line onto the connection's persistent control
/// channel, creating the channel on first use.
///
/// Fire-and-forget by design: the scroll protocol is idempotent (entering
/// copy-mode while already in it is a silent no-op in tmux), so neither a
/// reply nor an exit status is needed, and the driver simply drains the
/// channel's output to keep the SSH window from filling.
#[tauri::command]
pub async fn tmux_control_send(
    state: State<'_, SharedSessionManager>,
    conn_key: String,
    line: String,
) -> Result<(), String> {
    let tx = {
        let mgr = state.lock().map_err(|e| e.to_string())?;
        mgr.tmux_ctrl
            .get(&conn_key)
            .filter(|tx| !tx.is_closed())
            .cloned()
    };
    let tx = match tx {
        Some(tx) => tx,
        None => {
            let conn = get_conn(&state, &conn_key)?;
            let channel = conn.open_exec_channel(TMUX_CTRL_SCRIPT).await?;
            let (tx, rx) = mpsc::channel::<String>(256);
            spawn_tmux_control_driver(channel, rx, state.inner().clone(), &conn_key);
            let mut mgr = state.lock().map_err(|e| e.to_string())?;
            // A concurrent caller may have raced us; keep the first channel.
            mgr.tmux_ctrl.entry(conn_key).or_insert(tx).clone()
        }
    };
    tx.send(line)
        .await
        .map_err(|_| "tmux control channel is closed".to_string())
}

/// Pump queued command lines into the control channel while draining its
/// output. Runs on the interactive runtime; when the channel dies, the map
/// entry is dropped so the next command opens a fresh one.
fn spawn_tmux_control_driver(
    mut channel: russh::Channel<russh::client::Msg>,
    mut rx: mpsc::Receiver<String>,
    state: SharedSessionManager,
    conn_key: &str,
) {
    let conn_key = conn_key.to_string();
    crate::runtime::interactive().spawn(async move {
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(mut l) => {
                        l.push('\n');
                        if channel.data_bytes(l).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { .. })
                    | Some(ChannelMsg::ExtendedData { .. }) => {}
                    None | Some(ChannelMsg::Close) => break,
                    _ => {}
                },
            }
        }
        // Drop the map entry only if it is still this (now dead) channel —
        // a reconnect may already have replaced it.
        if let Ok(mut mgr) = state.lock() {
            if mgr.tmux_ctrl.get(&conn_key).is_some_and(|tx| tx.is_closed()) {
                mgr.tmux_ctrl.remove(&conn_key);
            }
        }
    });
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, SharedSessionManager>,
    conn_key: String,
    path: String,
) -> Result<SftpDirListing, String> {
    let conn = get_conn(&state, &conn_key)?;
    let sftp = conn.sftp().await?;
    // Resolve the path (e.g. "~" or ".") to an absolute one when possible.
    let path = sftp.canonicalize(&path).await.unwrap_or(path);
    let mut entries: Vec<SftpEntry> = sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?
        .map(|e| {
            let meta = e.metadata();
            SftpEntry {
                name: e.file_name(),
                path: e.path(),
                is_dir: e.file_type().is_dir(),
                size: meta.size,
            }
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(SftpDirListing { path, entries })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpProgress {
    pub transfer_id: String,
    pub file_name: String,
    pub direction: &'static str,
    pub done: u64,
    pub total: u64,
}

const TRANSFER_CHUNK: usize = 128 * 1024;

fn emit_progress(
    app: &AppHandle,
    window: &str,
    transfer_id: &str,
    file_name: &str,
    direction: &'static str,
    done: u64,
    total: u64,
) {
    let _ = app.emit_to(
        window,
        "sftp-progress",
        SftpProgress {
            transfer_id: transfer_id.to_string(),
            file_name: file_name.to_string(),
            direction,
            done,
            total,
        },
    );
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SharedSessionManager>,
    conn_key: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    file_name: String,
    priority: Option<String>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_key)?;
    let prio = crate::runtime::Priority::from_param(priority);
    // Bulk work runs on the transfer runtime, keeping the interactive
    // runtime (and Tauri's own) free for session I/O.
    let job = {
        let app = app.clone();
        let label = window.label().to_string();
        let tid = transfer_id.clone();
        let fname = file_name.clone();
        crate::runtime::transfer().spawn(async move {
            sftp_download_inner(&app, &label, conn, prio, &remote_path, &local_path, &tid, &fname).await
        })
    };
    match job.await.map_err(|e| format!("Transfer task failed: {e}"))? {
        Ok(()) => Ok(()),
        Err(e) => {
            // total: 0 signals a failed transfer so the frontend can clear it.
            emit_progress(&app, window.label(), &transfer_id, &file_name, "download", 0, 0);
            Err(e)
        }
    }
}

async fn sftp_download_inner(
    app: &AppHandle,
    window: &str,
    conn: std::sync::Arc<SshConnection>,
    priority: crate::runtime::Priority,
    remote_path: &str,
    local_path: &str,
    transfer_id: &str,
    file_name: &str,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let sftp = conn.sftp().await?;
    let total = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("Failed to stat remote file: {e}"))?
        .size
        .unwrap_or(0);
    let mut remote = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("Failed to open remote file: {e}"))?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| format!("Failed to create local file: {e}"))?;
    let mut buf = vec![0u8; TRANSFER_CHUNK];
    let mut done = 0u64;
    // Throttle progress events: at 128KB chunks a fast link would otherwise
    // emit hundreds of events per second and flood the webview.
    let mut last_emit = std::time::Instant::now();
    loop {
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        // Low-priority transfers pace themselves through the shared token
        // bucket so a bulk download cannot starve interactive shells
        // multiplexed on the same SSH connection.
        if priority.is_low() {
            crate::runtime::bulk_limiter().acquire(n).await;
        }
        local
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("Download failed: {e}"))?;
        done += n as u64;
        if last_emit.elapsed().as_millis() >= 100 {
            emit_progress(app, window, transfer_id, file_name, "download", done, total);
            last_emit = std::time::Instant::now();
        }
        if priority.is_low() {
            tokio::task::yield_now().await;
        }
    }
    emit_progress(app, window, transfer_id, file_name, "download", total, total);
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SharedSessionManager>,
    conn_key: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    file_name: String,
    priority: Option<String>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_key)?;
    let prio = crate::runtime::Priority::from_param(priority);
    let job = {
        let app = app.clone();
        let label = window.label().to_string();
        let tid = transfer_id.clone();
        let fname = file_name.clone();
        crate::runtime::transfer().spawn(async move {
            sftp_upload_inner(&app, &label, conn, prio, &local_path, &remote_path, &tid, &fname).await
        })
    };
    match job.await.map_err(|e| format!("Transfer task failed: {e}"))? {
        Ok(()) => Ok(()),
        Err(e) => {
            emit_progress(&app, window.label(), &transfer_id, &file_name, "upload", 0, 0);
            Err(e)
        }
    }
}

async fn sftp_upload_inner(
    app: &AppHandle,
    window: &str,
    conn: std::sync::Arc<SshConnection>,
    priority: crate::runtime::Priority,
    local_path: &str,
    remote_path: &str,
    transfer_id: &str,
    file_name: &str,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let sftp = conn.sftp().await?;
    let total = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("Failed to stat local file: {e}"))?
        .len();
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Failed to open local file: {e}"))?;
    let mut remote = sftp
        .create(remote_path)
        .await
        .map_err(|e| format!("Failed to create remote file: {e}"))?;
    let mut buf = vec![0u8; TRANSFER_CHUNK];
    let mut done = 0u64;
    let mut last_emit = std::time::Instant::now();
    loop {
        let n = local
            .read(&mut buf)
            .await
            .map_err(|e| format!("Upload failed: {e}"))?;
        if n == 0 {
            break;
        }
        if priority.is_low() {
            crate::runtime::bulk_limiter().acquire(n).await;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("Upload failed: {e}"))?;
        done += n as u64;
        if last_emit.elapsed().as_millis() >= 100 {
            emit_progress(app, window, transfer_id, file_name, "upload", done, total);
            last_emit = std::time::Instant::now();
        }
        if priority.is_low() {
            tokio::task::yield_now().await;
        }
    }
    emit_progress(app, window, transfer_id, file_name, "upload", total, total);
    Ok(())
}

/// Read a remote text file for in-app preview. Capped to avoid pulling
/// huge files into the webview; binary files are rejected.
#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, SharedSessionManager>,
    conn_key: String,
    remote_path: String,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    const MAX_PREVIEW_BYTES: u64 = 512 * 1024;

    let conn = get_conn(&state, &conn_key)?;
    let sftp = conn.sftp().await?;
    let file = sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("Failed to open remote file: {e}"))?;
    let mut buf = Vec::new();
    file.take(MAX_PREVIEW_BYTES)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("Failed to read remote file: {e}"))?;
    if buf.contains(&0) {
        return Err("Binary file: preview is not supported".to_string());
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Overwrite a remote text file with editor content. `create` truncates
/// the file if it exists.
#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, SharedSessionManager>,
    conn_key: String,
    remote_path: String,
    content: String,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let conn = get_conn(&state, &conn_key)?;
    let sftp = conn.sftp().await?;
    let mut file = sftp
        .create(&remote_path)
        .await
        .map_err(|e| format!("Failed to open remote file for writing: {e}"))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write remote file: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("Failed to finalize remote file: {e}"))?;
    Ok(())
}

pub(crate) fn get_conn(
    state: &State<'_, SharedSessionManager>,
    conn_key: &str,
) -> Result<Arc<SshConnection>, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.ssh_conns
        .get(conn_key)
        .cloned()
        .ok_or_else(|| "SSH connection does not exist or has been closed".to_string())
}
