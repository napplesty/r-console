//! SSH connection and channel management.
//!
//! A single `SshConnection` multiplexes multiple channels over one TCP
//! connection: one shell channel per terminal tab, plus one shared SFTP
//! subsystem channel for the file panel. Each shell channel is driven by a
//! dedicated async task; frontend input arrives through an mpsc queue.

use russh::client::{AuthResult, Handle, Handler};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshAuth {
    Password { password: String },
    Key {
        #[serde(rename = "keyPath")]
        key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// Run the shell inside a persistent tmux session so it survives
    /// disconnects and app restarts.
    #[serde(default = "default_persistent")]
    pub persistent: bool,
    /// Name of the tmux session to attach-or-create. Generated once per
    /// pane by the frontend and reused on every reconnect; only meaningful
    /// when `persistent` is set.
    #[serde(default)]
    pub tmux_session: Option<String>,
}

fn default_persistent() -> bool {
    true
}

impl SshConnectConfig {
    pub fn conn_key(&self) -> String {
        format!("{}@{}:{}", self.username, self.host, self.port)
    }
}

/// Server host key verification against ~/.ssh/known_hosts (OpenSSH
/// semantics): known & matching → accept; unknown → ask the user (TOFU) and
/// record on accept; changed → warn and reject (possible MITM).
struct ClientHandler {
    host: String,
    port: u16,
    app: AppHandle,
    /// Label of the window that initiated the connection; host-key prompts
    /// are targeted at it rather than broadcast.
    window: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
}

fn host_key_info(host: &str, port: u16, key: &PublicKey) -> HostKeyInfo {
    HostKeyInfo {
        host: host.to_string(),
        port,
        key_type: key.algorithm().to_string(),
        fingerprint: key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
    }
}

/// User decisions for unknown host keys, keyed by "host:port".
static PENDING_HOST_KEYS: OnceLock<
    std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
> = OnceLock::new();

fn pending_host_keys() -> &'static std::sync::Mutex<
    HashMap<String, tokio::sync::oneshot::Sender<bool>>,
> {
    PENDING_HOST_KEYS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

async fn prompt_host_key(
    app: &AppHandle,
    window: &str,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> bool {
    let id = format!("{host}:{port}");
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending_host_keys()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), tx);
    if app
        .emit_to(window, "host-key-confirm", host_key_info(host, port, key))
        .is_err()
    {
        pending_host_keys()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        return false;
    }
    // No response within 2 minutes counts as rejection.
    let accept = matches!(
        tokio::time::timeout(Duration::from_secs(120), rx).await,
        Ok(Ok(true))
    );
    pending_host_keys()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    accept
}

/// Frontend answer to the `host-key-confirm` prompt.
#[tauri::command]
pub fn host_key_decision(host: String, port: u16, accept: bool) -> Result<(), String> {
    let id = format!("{host}:{port}");
    if let Some(tx) = pending_host_keys()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
    {
        let _ = tx.send(accept);
    }
    Ok(())
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        use russh::keys::known_hosts;
        match known_hosts::check_known_hosts(&self.host, self.port, key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let accept =
                    prompt_host_key(&self.app, &self.window, &self.host, self.port, key).await;
                if accept {
                    let _ = known_hosts::learn_known_hosts(&self.host, self.port, key);
                }
                Ok(accept)
            }
            Err(russh::keys::Error::KeyChanged { .. }) => {
                // Recorded key differs from what the server presented.
                let _ = self.app.emit_to(
                    self.window.as_str(),
                    "host-key-mismatch",
                    host_key_info(&self.host, self.port, key),
                );
                Ok(false)
            }
            Err(_) => {
                // known_hosts missing/unreadable: fall back to asking.
                Ok(prompt_host_key(&self.app, &self.window, &self.host, self.port, key).await)
            }
        }
    }
}

pub struct SshConnection {
    handle: Mutex<Handle<ClientHandler>>,
    sftp: Mutex<Option<Arc<SftpSession>>>,
}

impl SshConnection {
    pub async fn connect(
        cfg: &SshConnectConfig,
        app: AppHandle,
        window: String,
    ) -> Result<Self, String> {
        let config = Arc::new(russh::client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });
        let mut handle = russh::client::connect(
            config,
            (cfg.host.as_str(), cfg.port),
            ClientHandler {
                host: cfg.host.clone(),
                port: cfg.port,
                app,
                window,
            },
        )
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

        match &cfg.auth {
            SshAuth::Password { password } => {
                let res = handle
                    .authenticate_password(&cfg.username, password)
                    .await
                    .map_err(|e| format!("Authentication error: {e}"))?;
                ensure_auth_success(res)?;
            }
            SshAuth::Key {
                key_path,
                passphrase,
            } => {
                let key = russh::keys::load_secret_key(key_path, passphrase.as_deref())
                    .map_err(|e| format!("Failed to load private key: {e}"))?;
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| e.to_string())?
                    .flatten();
                let res = handle
                    .authenticate_publickey(
                        &cfg.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| format!("Authentication error: {e}"))?;
                ensure_auth_success(res)?;
            }
        }

        Ok(Self {
            handle: Mutex::new(handle),
            sftp: Mutex::new(None),
        })
    }

    /// Run a command on a fresh exec channel and collect its output.
    pub async fn exec(&self, command: &str) -> Result<String, String> {
        Ok(self.exec_full(command).await?.0)
    }

    /// Single-round-trip latency probe: an SSH keepalive ping, waiting for
    /// the server's pong. Unlike timing an exec, this excludes channel and
    /// remote shell setup, so it tracks the actual link RTT.
    pub async fn ping(&self) -> Result<u64, String> {
        let start = std::time::Instant::now();
        self.handle
            .lock()
            .await
            .send_ping()
            .await
            .map_err(|e| format!("Ping failed: {e}"))?;
        Ok(start.elapsed().as_millis() as u64)
    }

    /// Run a command, returning its combined output and exit status.
    pub(crate) async fn exec_full(&self, command: &str) -> Result<(String, Option<u32>), String> {
        let mut channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open exec channel: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Failed to exec command: {e}"))?;
        let mut out = String::new();
        let mut status = None;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    out.push_str(&String::from_utf8_lossy(data.as_ref()));
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    out.push_str(&String::from_utf8_lossy(data.as_ref()));
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    status = Some(exit_status);
                }
                None | Some(ChannelMsg::Close) => break,
                _ => {}
            }
        }
        Ok((out, status))
    }

    /// Open a long-lived exec channel running `command` (used for the
    /// per-connection tmux control loop).
    pub async fn open_exec_channel(
        &self,
        command: &str,
    ) -> Result<russh::Channel<russh::client::Msg>, String> {
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open exec channel: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Failed to exec command: {e}"))?;
        Ok(channel)
    }

    /// Get (or lazily establish) the SFTP session on this connection.
    pub async fn sftp(&self) -> Result<Arc<SftpSession>, String> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open SFTP channel: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("Failed to request SFTP subsystem: {e}"))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("Failed to initialize SFTP: {e}"))?;
        let session = Arc::new(session);
        *guard = Some(session.clone());
        Ok(session)
    }
}

fn ensure_auth_success(res: AuthResult) -> Result<(), String> {
    if res.success() {
        Ok(())
    } else {
        Err("Authentication failed: invalid credentials or rejected by server".to_string())
    }
}

/// Input for a shell channel, delivered from frontend commands via mpsc.
pub enum ShellInput {
    Data(Vec<u8>),
    Resize(u16, u16),
}

/// Bounded per-session input queue; a full queue fails the write command
/// fast instead of growing memory behind a stalled channel.
const INPUT_QUEUE: usize = 256;

/// Handle of one SSH terminal session, stored in the SessionManager.
pub struct SshShell {
    input: mpsc::Sender<ShellInput>,
}

impl SshShell {
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.input
            .try_send(ShellInput::Data(data.to_vec()))
            .map_err(|_| "SSH session is closed or busy".to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.input
            .try_send(ShellInput::Resize(cols, rows))
            .map_err(|_| "SSH session is closed or busy".to_string())
    }

    /// Open a new shell channel on the connection and spawn its driver task.
    ///
    /// With `persistent`, the channel runs `tmux new-session -A` instead of a
    /// plain shell: the remote session (processes, scrollback, cwd) survives
    /// disconnects and is reattached on reconnect.
    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        conn: Arc<SshConnection>,
        shared: crate::session::SharedSessionManager,
        conn_key: String,
        app: AppHandle,
        session_id: String,
        cols: u16,
        rows: u16,
        window: String,
        persistent: bool,
        tmux_session: Option<String>,
    ) -> Result<Self, String> {
        let channel = conn
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open shell channel: {e}"))?;
        // Best-effort: advertise truecolor support. Most sshd builds reject
        // env vars not in AcceptEnv, so failures are expected and ignored.
        let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
        channel
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {e}"))?;

        // Shell integration is only injected into sessions we CREATE —
        // see the persistent branch below.
        let mut inject_shell_init = !persistent;

        if persistent {
            let name = tmux_session.as_deref().unwrap_or("rc-main");
            // Names come from the frontend; sanitize before embedding in a
            // shell command line.
            if !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err("Invalid tmux session name".to_string());
            }
            let probe = conn.exec("command -v tmux").await?;
            if probe.trim().is_empty() {
                return Err(
                    "tmux is not installed on the remote host. Disable 'Persistent session' or install tmux."
                        .to_string(),
                );
            }
            // Probe first so we know whether this is an attach or a create:
            // the shell-integration snippet ends with `clear`, and injecting
            // it into a reattached session would wipe the visible screen
            // (making a resumed session look like a fresh window) and
            // duplicate the prompt hooks.
            let exists = conn
                .exec(&format!(
                    "tmux has-session -t {name} 2>/dev/null && echo yes"
                ))
                .await?
                .trim()
                == "yes";
            // On create, make tmux feel native: no status bar, a large
            // history, OSC sequences (cwd reporting) passed through to the
            // outer terminal. Mouse stays OFF on purpose: wheel and
            // selection are owned by the frontend, which drives tmux
            // copy-mode through the control channel — selection then
            // behaves like a plain SSH session. `-q` silences
            // unknown-option errors on older tmux versions.
            let cmd = if exists {
                format!("tmux attach-session -t {name}")
            } else {
                format!(
                    "tmux new-session -s {name} \\; set -q -t {name} status off \\; set -q -t {name} mouse off \\; set -q -t {name} history-limit 50000 \\; set -q -t {name} allow-passthrough on"
                )
            };
            channel
                .exec(true, cmd.as_str())
                .await
                .map_err(|e| format!("Failed to start tmux: {e}"))?;
            if !exists {
                inject_shell_init = true;
                // Give tmux a moment to spawn the pane shell before injecting
                // the shell-integration snippet, or the keystrokes can be lost.
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        } else {
            channel
                .request_shell(true)
                .await
                .map_err(|e| format!("Failed to request shell: {e}"))?;
        }

        // Shell integration: report the working directory via OSC 7 so the
        // SFTP panel can follow the terminal. Best-effort; ignore failures.
        if inject_shell_init {
            let _ = channel.data_bytes(crate::session::SHELL_INIT).await;
        }

        let (tx, mut rx) = mpsc::channel::<ShellInput>(INPUT_QUEUE);
        let data_event = format!("session-data-{}", session_id);
        let exit_event = format!("session-exit-{}", session_id);

        // Driver task runs on the single-threaded interactive runtime: all
        // user-facing session I/O is serialized on one core, isolated from
        // bulk transfers. Output is batched via OutputSink to keep IPC
        // event frequency low.
        let disconnect_event = format!("session-disconnect-{}", session_id);
        crate::runtime::interactive().spawn(async move {
            let mut channel = channel;
            let mut sink =
                crate::runtime::OutputSink::new(app.clone(), window.clone(), data_event);
            // Why the loop ended decides which event the window gets:
            // Clean = remote side closed the channel (e.g. `exit` typed);
            // ByUser = frontend dropped the input sender (pane closed);
            // Lost = transport died unexpectedly (reconnect candidate).
            enum End {
                Clean,
                ByUser,
                Lost,
            }
            let end = loop {
                tokio::select! {
                    input = rx.recv() => {
                        match input {
                            Some(ShellInput::Data(d)) => {
                                if channel.data_bytes(d).await.is_err() { break End::Lost; }
                            }
                            Some(ShellInput::Resize(c, r)) => {
                                let _ = channel.window_change(c as u32, r as u32, 0, 0).await;
                            }
                            None => break End::ByUser,
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                if !sink.push(data.as_ref()) { return; }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if !sink.push(data.as_ref()) { return; }
                            }
                            Some(ChannelMsg::Close) => break End::Clean,
                            None => break End::Lost,
                            _ => {}
                        }
                    }
                    _ = tokio::time::sleep(crate::runtime::FLUSH_IDLE), if !sink.is_empty() => {
                        if !sink.flush() { return; }
                    }
                }
            };
            sink.flush();
            match end {
                End::Clean => {
                    let _ = app.emit_to(window.as_str(), &exit_event, ());
                }
                End::ByUser => {}
                End::Lost => {
                    // Drop the dead connection from the pool so a reconnect
                    // establishes a fresh one instead of reusing a zombie.
                    {
                        let mut mgr = shared.lock().unwrap_or_else(|e| e.into_inner());
                        mgr.drop_connection_if(&conn_key, &conn);
                    }
                    let _ = app.emit_to(window.as_str(), &disconnect_event, ());
                }
            }
        });

        Ok(Self { input: tx })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}
