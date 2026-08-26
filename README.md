# r-console

A cross-platform, modern terminal and remote session manager — think MobaXterm, but built with Tauri 2 + React, with a Rust core for performance.

[![release](https://img.shields.io/github/v/release/napplesty/r-console)](https://github.com/napplesty/r-console/releases/latest)

## Download

Grab the latest installer from [**Releases → latest**](https://github.com/napplesty/r-console/releases/latest):

| Platform | File |
|----------|------|
| Windows  | `*-setup.exe` (NSIS installer; `.msi` also available) |
| macOS    | `*.dmg` (Apple Silicon) |
| Linux    | `*.AppImage` (portable, auto-updates), `*.deb`, `*.rpm` |

Windows, macOS and AppImage builds update themselves automatically (Settings → About → "Check for updates", or the ⌘K palette). deb/rpm installs update via the package manager.

### macOS: trusting the unsigned app

The builds are not signed yet (no Apple Developer certificate), so macOS puts a
quarantine flag on the download and Gatekeeper shows **"R Console is damaged
and can't be opened"** — the app itself is fine, only the flag is in the way.
After dragging **R Console.app** into `/Applications`, remove the flag:

```sh
xattr -r -d com.apple.quarantine "/Applications/R Console.app"
```

If `xattr` reports "No such xattr", the flag is already gone and a plain
right-click → **Open** the first time is enough ("unidentified developer"
dialog). On some macOS versions the `xattr` call needs `sudo`. Once a signing
certificate is set up, signed + notarized builds will make this step
unnecessary.

## Features

- **SSH sessions** — built on [russh](https://github.com/Eugeny/russh), with support for password / public-key auth and `~/.ssh/config` import
- **Persistent sessions via tmux** — SSH shells attach to a tmux session on the remote host; network drops trigger automatic reconnect with exponential backoff, and the remote session survives
- **Local shell** — native PTY (zsh/bash/pwsh) on macOS, Linux and Windows, with the same toolkit as SSH panes: file browser, Git panel, system stats in the status bar
- **Tabs & split panes** — group multiple terminals, broadcast input to a whole tab group (MobaXterm-style multi-exec)
- **File browser** — browse remote (SFTP) or local directories, in-place content search (grep), and open files in floating editor windows
- **Floating editor windows** — multiple Monaco editors at once (the editor that powers VS Code): draggable, resizable, modeless — keep typing in the terminal while you edit
- **Git panel** — status / staging / commits and Monaco diff view, over the SSH connection or on local repos; follows the terminal's working directory
- **Host key verification** — TOFU (trust on first use) against `~/.ssh/known_hosts`, with mismatch warnings
- **Credential vault** — passwords encrypted at rest with Argon2id + AES-256-GCM, unlocked with a master password
- **Status bar** — live latency, remote CPU / memory / disk usage, SFTP transfer progress
- **Settings page** (⌘,) — theme picker with live previews (incl. the crisp **Sharp Dark**), font & cursor, scrollback, keyword-highlight rule editor, IME compatibility mode
- **Workspace restore** — reopen your tabs and sessions where you left off
- **Auto-update** — signed in-app updates from GitHub Releases (Windows / macOS / AppImage)
- **Command palette** (⌘K), keyword highlighting in terminal output, FPS overlay diagnostics, Ctrl+Shift+C/V clipboard

## Tech stack

| Layer    | Tech |
|----------|------|
| Shell    | Tauri 2 |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, Zustand |
| Terminal | xterm.js (WebGL renderer) |
| Editor   | Monaco (lazy-loaded chunk) |
| Backend  | Rust — russh (SSH), russh-sftp, portable-pty, tokio |

### Runtime architecture

- All interactive session I/O (terminal input/output) runs on a **dedicated single-threaded tokio runtime**, fully async, so latency-sensitive keystrokes never contend with bulk work
- Bulk data (SFTP transfers) runs on a **separate thread pool** with a token-bucket rate limiter and low-priority scheduling, keeping the terminal responsive during large transfers
- PTY output is bounded (backpressure via bounded channels) and batched before crossing to the webview
- Events are delivered per-window (`emit_to`), ready for multi-window support

## Development

Prerequisites: [Rust](https://rustup.rs/), Node.js 20+, and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev        # run in debug mode
npm run build            # type-check + frontend build
npm run tauri build      # produce platform installers (dmg / msi / deb)
```

User data (saved sessions, workspace, credential vault) lives in `~/.r-console/`.

### Project layout

```
src/            React frontend
  components/   UI components (Terminal, Sidebar, SftpPanel, ...)
  state/        Zustand store, session lifecycle, workspace persistence
  lib/          types, themes, monaco setup, perf helpers, tmux scroll
src-tauri/src/  Rust backend
  ssh.rs        SSH connection pool, persistent (tmux) sessions
  session.rs    session manager, commands, event routing
  runtime.rs    interactive / transfer runtimes, rate limiting
  local_pty.rs  local PTY sessions
  localfs.rs    local-filesystem file browser backend
  sftp / sysmon / credentials / workspace / ...
scripts/        icon generation (pixel-art `>_`, Pillow)
```

## Roadmap

- [x] Git panel (run git over the existing SSH connection, Monaco diff view)
- [x] Settings page (themes, font, scrollback, highlight rules)
- [ ] Dev container / docker exec sessions
- [ ] Port forwarding UI (local / remote / dynamic)
- [ ] Multi-window support (event layer is already per-window)
- [ ] Plugin system
- [ ] Session recording / replay
- [ ] Drag & drop tab reordering

## Icon

Retro-futurist pixel-art `>_`, green-on-black. Regenerate with:

```sh
python3 scripts/generate_icon.py
npm run tauri icon src-tauri/icons/icon.png
```

## License

TBD (planned as open source).
