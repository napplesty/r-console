//! Local pseudo-terminal (PTY) sessions: wraps portable-pty.
//!
//! portable-pty exposes blocking readers/writers, so the raw syscalls live
//! on two dedicated threads per session. Both are decoupled from the async
//! world through bounded channels — this gives end-to-end backpressure and
//! a hard memory bound: if the webview falls behind, the reader thread
//! blocks, the OS pipe fills, and the producing process stops instead of
//! piling up buffers. Output reaches the window through a batching task on
//! the single-threaded interactive runtime.

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter};

/// Bounded per-session input queue. A full queue means the shell is not
/// consuming; the write command then fails fast instead of growing memory.
const INPUT_QUEUE: usize = 256;
/// Bounded per-session output queue, in `READ_CHUNK`-sized pieces
/// (at most 64 × 8 KiB = 512 KiB in flight per session).
const OUTPUT_QUEUE: usize = 64;
const READ_CHUNK: usize = 8192;

pub struct LocalPty {
    input: tokio::sync::mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[cfg(unix)]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[cfg(windows)]
fn default_shell() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

impl LocalPty {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        app: AppHandle,
        session_id: &str,
        cols: u16,
        rows: u16,
        window: &str,
        cwd: Option<&str>,
    ) -> Result<Self, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(default_shell());
        // Land the shell in the requested directory ("open terminal here").
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        // Advertise a 256-color terminal; some environments lack TERM,
        // which silently disables colored output in shells and tools.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // macOS/BSD ls colors: CLICOLOR enables them, LSCOLORS picks a palette
        // readable on dark backgrounds (Linux ls uses --color=auto via aliases).
        #[cfg(unix)]
        {
            cmd.env("CLICOLOR", "1");
            cmd.env("LSCOLORS", "ExGxFxdaCxDaDahbadacec");
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // Shell integration: report the working directory via OSC 7 (see
        // session::SHELL_INIT). Best-effort; ignore failures.
        let _ = writer.write_all(crate::session::SHELL_INIT.as_bytes());
        let _ = writer.flush();

        // Output path: blocking reader thread -> bounded channel -> batching
        // task on the interactive runtime.
        let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(OUTPUT_QUEUE);
        std::thread::Builder::new()
            .name(format!("rc-pty-read-{session_id}"))
            .spawn(move || {
                let mut buf = [0u8; READ_CHUNK];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            // blocking_send applies backpressure when the
                            // webview falls behind.
                            if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let data_event = format!("session-data-{session_id}");
        let exit_event = format!("session-exit-{session_id}");
        let window = window.to_string();
        crate::runtime::interactive().spawn(async move {
            let mut sink =
                crate::runtime::OutputSink::new(app.clone(), window.clone(), data_event);
            loop {
                if sink.is_empty() {
                    match out_rx.recv().await {
                        Some(chunk) => {
                            if !sink.push(&chunk) {
                                return;
                            }
                        }
                        None => break,
                    }
                } else {
                    tokio::select! {
                        chunk = out_rx.recv() => match chunk {
                            Some(c) => { if !sink.push(&c) { return; } }
                            None => break,
                        },
                        _ = tokio::time::sleep(crate::runtime::FLUSH_IDLE) => {
                            if !sink.flush() { return; }
                        }
                    }
                }
            }
            sink.flush();
            let _ = app.emit_to(window.as_str(), &exit_event, ());
        });

        // Input path: bounded channel -> dedicated writer thread. Writing to
        // a PTY master can block when the pipe is full; keeping it off the
        // command handler avoids stalling unrelated sessions.
        let (in_tx, mut in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(INPUT_QUEUE);
        std::thread::Builder::new()
            .name(format!("rc-pty-write-{session_id}"))
            .spawn(move || {
                while let Some(data) = in_rx.blocking_recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            input: in_tx,
            master: pair.master,
            child,
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.input
            .try_send(data.to_vec())
            .map_err(|_| "PTY input queue is full or closed".to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        // Dropping the input sender ends the writer thread; dropping the
        // master makes the reader hit EOF, which ends the bridge task and
        // emits the session-exit event.
    }
}
