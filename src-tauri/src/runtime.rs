//! Runtime topology and scheduling primitives.
//!
//! - `interactive()`: a single-threaded tokio runtime pinned to one
//!   dedicated OS thread. All user-facing session drivers (local PTY
//!   bridges, SSH shell channels) run here, so interactive latency is
//!   isolated from bulk work and never competes for cores.
//! - `transfer()`: a small multi-thread runtime for bulk data movement
//!   (SFTP up/downloads). Tasks here self-throttle and yield so the
//!   interactive path stays responsive.
//! - Tauri's own runtime stays untouched: it drives the webview IPC and
//!   command dispatch, as intended by the framework.
//!
//! `OutputSink` batches raw output into larger IPC events (terminal
//! producers easily emit hundreds of small chunks per second; one event per
//! chunk would bury the webview in IPC overhead).

use std::future::Future;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::runtime::{Handle, Runtime};

/// Flush a pending output batch after this much quiet time.
pub const FLUSH_IDLE: Duration = Duration::from_millis(8);
/// Flush a pending output batch once it reaches this size.
pub const FLUSH_BYTES: usize = 32 * 1024;
/// Default pacing for low-priority bulk transfers. The goal is not bandwidth
/// capping but leaving headroom on the shared SSH connection for interactive
/// shells; expose as a user setting later if needed.
const DEFAULT_BULK_RATE_BPS: u64 = 64 * 1024 * 1024;

static INTERACTIVE: OnceLock<Handle> = OnceLock::new();
static TRANSFER: OnceLock<Runtime> = OnceLock::new();

/// Handle of the single-threaded interactive runtime. A current_thread
/// runtime only progresses while something drives it, so a dedicated thread
/// parks inside `block_on` and all session tasks are spawned onto it.
pub fn interactive() -> &'static Handle {
    INTERACTIVE.get_or_init(|| {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build interactive runtime");
        let handle = rt.handle().clone();
        std::thread::Builder::new()
            .name("rc-interactive".to_string())
            .spawn(move || rt.block_on(std::future::pending::<()>()))
            .expect("failed to spawn interactive runtime thread");
        handle
    })
}

/// Multi-thread runtime for bulk transfers (SFTP).
pub fn transfer() -> &'static Runtime {
    TRANSFER.get_or_init(|| {
        let workers = (std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            / 2)
            .clamp(2, 4);
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(workers)
            .thread_name("rc-transfer".to_string())
            .enable_all()
            .build()
            .expect("failed to build transfer runtime")
    })
}

/// Run one potentially slow task on the transfer pool and wait for it.
/// Used for heavy local work (recursive grep/delete/copy, local git) so it
/// never occupies the interactive thread or the IPC dispatch path.
pub async fn run_bulk<F, T>(fut: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>> + Send + 'static,
    T: Send + 'static,
{
    match transfer().spawn(fut).await {
        Ok(res) => res,
        Err(e) => Err(format!("Background task failed: {e}")),
    }
}

/// Eagerly start both runtimes so thread names show up in debug tools from
/// the beginning rather than on first use.
pub fn init() {
    interactive();
    transfer();
}

/// Scheduling class for background work. Interactive sessions never carry a
/// priority — they live on their own runtime and bypass every limiter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// Skips the rate limiter (e.g. small preview reads).
    High,
    /// Rate-limited and yielding (default for bulk transfers).
    Low,
}

impl Priority {
    pub fn from_param(param: Option<String>) -> Self {
        match param.as_deref() {
            Some("high") => Self::High,
            _ => Self::Low,
        }
    }

    pub fn is_low(self) -> bool {
        matches!(self, Self::Low)
    }
}

/// Async token bucket shared by all low-priority transfers.
pub struct RateLimiter {
    state: tokio::sync::Mutex<Bucket>,
    rate: f64,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    pub fn new(bytes_per_sec: u64) -> Self {
        Self {
            state: tokio::sync::Mutex::new(Bucket {
                tokens: bytes_per_sec as f64,
                last: Instant::now(),
            }),
            rate: bytes_per_sec as f64,
        }
    }

    /// Wait until `n` bytes worth of tokens are available, then consume them.
    pub async fn acquire(&self, n: usize) {
        let n = n as f64;
        loop {
            let wait = {
                let mut b = self.state.lock().await;
                let now = Instant::now();
                b.tokens =
                    (b.tokens + now.duration_since(b.last).as_secs_f64() * self.rate).min(self.rate);
                b.last = now;
                if b.tokens >= n {
                    b.tokens -= n;
                    None
                } else {
                    Some(Duration::from_secs_f64((n - b.tokens) / self.rate))
                }
            };
            match wait {
                None => return,
                Some(d) => tokio::time::sleep(d).await,
            }
        }
    }
}

/// Global limiter for low-priority bulk transfers.
pub fn bulk_limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| RateLimiter::new(DEFAULT_BULK_RATE_BPS))
}

/**
 * Batches raw output chunks into coalesced IPC events targeted at one
 * window. Flushes when the batch reaches `FLUSH_BYTES` or when the caller
 * asks after an idle period (`FLUSH_IDLE`). Once the target window is gone
 * the sink is permanently broken.
 */
pub struct OutputSink {
    app: AppHandle,
    window: String,
    event: String,
    buf: Vec<u8>,
    broken: bool,
}

impl OutputSink {
    pub fn new(app: AppHandle, window: String, event: String) -> Self {
        Self {
            app,
            window,
            event,
            buf: Vec::new(),
            broken: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Append a chunk, flushing early when the batch is full. Returns false
    /// when the target window no longer exists.
    pub fn push(&mut self, data: &[u8]) -> bool {
        if self.broken {
            return false;
        }
        self.buf.extend_from_slice(data);
        if self.buf.len() >= FLUSH_BYTES {
            return self.flush();
        }
        true
    }

    /// Emit the pending batch (if any). Returns false when the target
    /// window no longer exists.
    pub fn flush(&mut self) -> bool {
        if self.broken {
            return false;
        }
        if !self.buf.is_empty() {
            let text = String::from_utf8_lossy(&self.buf).to_string();
            self.buf.clear();
            if self
                .app
                .emit_to(self.window.as_str(), &self.event, text)
                .is_err()
            {
                self.broken = true;
                return false;
            }
        }
        true
    }
}
