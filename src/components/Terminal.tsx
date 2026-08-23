import { useEffect, useRef, useState } from "react";
import { Terminal, type IDecoration, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../state/store";
import { getTheme, type AppTheme } from "../lib/themes";
import { clearTermStats, recordTermEvent, recordTermWrite } from "../lib/perf";
import { cancelReconnect, retryReconnect } from "../state/sessions";
import {
  matchLine,
  resolveHighlightColor,
  type HighlightPalette,
} from "../lib/terminalHighlight";
import { TmuxScrollController } from "../lib/tmuxScroll";
import ConnectDialog from "./ConnectDialog";
import type { Pane } from "../lib/types";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  tabId: string;
  pane: Pane;
  /** Inactive tabs stay mounted (hidden) to preserve scrollback. */
  active: boolean;
  onExit?: () => void;
  /** Called when the transport drops unexpectedly (SSH only). */
  onDisconnect?: () => void;
}

// Perf guards for the keyword-highlight scan loop (see effect A).
const HIGHLIGHT_MAX_ROWS_PER_TICK = 200;
const HIGHLIGHT_FLOOD_ROWS_PER_SEC = 1500;
const HIGHLIGHT_FLOOD_COOLDOWN_MS = 15_000;

/** Concrete decoration colors for the named highlight severities. */
function buildHighlightPalette(theme: AppTheme): HighlightPalette {
  return {
    error: theme.xterm.red ?? "#f7768e",
    warn: theme.xterm.yellow ?? "#e0af68",
    success: theme.xterm.green ?? "#9ece6a",
    info: theme.xterm.blue ?? theme.chrome.accent,
    accent: theme.chrome.accent,
    dim: theme.chrome.dim,
  };
}

/**
 * One terminal view: xterm.js rendering plus the data channel to a backend
 * session (local PTY or SSH — the event protocol is identical).
 *
 * Effect A mounts xterm once per pane; effect B subscribes to the backend
 * session's events and re-runs when a reconnect swaps in a fresh session
 * id — so reconnecting preserves the viewport and local scrollback.
 */
export default function TerminalView({
  tabId,
  pane,
  active,
  onExit,
  onDisconnect,
}: TerminalViewProps) {
  const sessionId = pane.sessionId;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;
  // Mutable bridges so the once-mounted terminal always sees current values.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const enqueueRef = useRef<(data: string) => void>(() => {});
  const syncSizeRef = useRef<() => void>(() => {});
  // Dead panes without resolvable credentials offer the connect dialog.
  const [credDialogOpen, setCredDialogOpen] = useState(false);
  const themeId = useAppStore((s) => s.themeId);
  // Highlight colors follow the theme; read by the scan loop in effect A.
  const highlightPaletteRef = useRef<HighlightPalette>(
    buildHighlightPalette(getTheme(themeId)),
  );

  // Effect A: mount xterm once per pane.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      // Mirrors --font-mono in index.css; xterm needs an explicit family.
      fontFamily:
        "'JetBrains Mono', 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace",
      scrollback: useAppStore.getState().scrollback,
      // Theme snapshot at construction; live updates happen in the effect below.
      theme: getTheme(useAppStore.getState().themeId).xterm,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    // Reserve a left strip for the command-status gutter dots; the fit
    // addon subtracts element padding, so column math stays correct.
    term.element!.style.paddingLeft = "16px";
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // Fall back to canvas rendering when WebGL is unavailable.
    }
    termRef.current = term;
    fitRef.current = fitAddon;

    // Backpressure queue: term.write() parses synchronously, so flooding it
    // (e.g. `cat` on a large file) blocks the UI. Write one merged chunk at a
    // time and let the write callback pull the next one. Each chunk carries
    // its arrival time so perf.ts can measure event-to-painted latency.
    let queue: { data: string; t0: number }[] = [];
    let writing = false;
    const flush = () => {
      if (writing || queue.length === 0) return;
      writing = true;
      const t0 = queue[0].t0;
      const chunk =
        queue.length > 1
          ? queue
              .splice(0)
              .map((c) => c.data)
              .join("")
          : queue.shift()!.data;
      const writeStart = performance.now();
      term.write(chunk, () => {
        const sid = sessionIdRef.current;
        if (sid) {
          recordTermWrite(
            sid,
            performance.now() - writeStart,
            performance.now() - t0,
          );
        }
        writing = false;
        flush();
      });
    };
    const enqueue = (data: string) => {
      const sid = sessionIdRef.current;
      if (sid) recordTermEvent(sid, data.length);
      queue.push({ data, t0: performance.now() });
      flush();
    };
    enqueueRef.current = enqueue;

    // Overlay scrollbar (xterm.js has no native widget): a thin thumb on
    // the right edge tracking viewportY / baseY, draggable. Hidden while
    // there is no local scrollback — tmux panes keep history remotely and
    // stay in the alternate screen, so nothing appears for them.
    const track = document.createElement("div");
    track.className = "rc-scrollbar";
    const thumb = document.createElement("div");
    thumb.className = "rc-scrollbar-thumb";
    track.appendChild(thumb);
    container.appendChild(track);

    const updateScrollbar = () => {
      const buf = term.buffer.active;
      const trackH = track.clientHeight;
      if (buf.type !== "normal" || buf.baseY === 0 || trackH === 0) {
        thumb.style.display = "none";
        return;
      }
      const total = buf.baseY + term.rows;
      const height = Math.max(24, Math.round((term.rows / total) * trackH));
      const top = Math.round((buf.viewportY / buf.baseY) * (trackH - height));
      thumb.style.display = "block";
      thumb.style.height = `${height}px`;
      thumb.style.top = `${top}px`;
    };
    const scrollbarDisposables = [
      term.onScroll(updateScrollbar),
      term.onWriteParsed(updateScrollbar),
    ];

    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startViewportY = term.buffer.active.viewportY;
      const range = track.clientHeight - thumb.clientHeight;
      if (range <= 0) return;
      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientY - startY;
        const target = Math.round(
          startViewportY + (delta / range) * term.buffer.active.baseY,
        );
        term.scrollToLine(target);
      };
      const onUp = () => window.removeEventListener("pointermove", onMove);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    });
    // The thumb swallows wheel events that should scroll the terminal.
    thumb.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        term.scrollLines(e.deltaY > 0 ? 3 : -3);
      },
      { passive: false },
    );

    // OSC 7 shell integration: the backend injects a hook that reports the
    // working directory as `file://host/path` after each prompt. The
    // `followCwd` setting lets the user opt out entirely.
    term.parser.registerOscHandler(7, (data) => {
      const sid = sessionIdRef.current;
      if (!sid || !useAppStore.getState().followCwd) return true;
      const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
      if (m) {
        useAppStore.getState().setSessionCwd(sid, decodeURIComponent(m[1]));
      }
      return true;
    });

    // Shell integration command marks (VS Code-style): the backend injects
    // OSC 133 hooks (see session::SHELL_INIT). A drops a marker on the
    // prompt line; D;<exit> records the previous command's exit code. The
    // gutter dots overlay the strip reserved by the left padding above.
    interface CommandMark {
      marker: IMarker;
      /** Marks only render while their buffer is the active one. */
      bufferType: "normal" | "alternate";
      exitCode?: number;
      dot?: HTMLDivElement;
    }
    const commandMarks: CommandMark[] = [];
    let lastCommandMark: CommandMark | null = null;

    const gutter = document.createElement("div");
    gutter.className = "rc-gutter";
    container.appendChild(gutter);

    // Cached geometry: only changes on fit/resize, so measuring here keeps
    // the scroll/render handlers free of layout reads.
    let gutterTop = 0;
    let cellHeight = 0;
    const measureGutter = () => {
      const screenEl = container.querySelector<HTMLElement>(".xterm-screen");
      if (!screenEl || term.rows === 0) return;
      gutterTop =
        screenEl.getBoundingClientRect().top -
        container.getBoundingClientRect().top;
      cellHeight = screenEl.clientHeight / term.rows;
    };

    const updateGutter = () => {
      if (cellHeight === 0) measureGutter();
      const buf = term.buffer.active;
      for (let i = commandMarks.length - 1; i >= 0; i--) {
        const mark = commandMarks[i];
        if (mark.marker.isDisposed) {
          mark.dot?.remove();
          commandMarks.splice(i, 1);
          continue;
        }
        const y = mark.marker.line - buf.viewportY;
        const visible =
          mark.bufferType === buf.type &&
          y >= 0 &&
          y < term.rows &&
          cellHeight > 0;
        if (!visible) {
          if (mark.dot) mark.dot.style.display = "none";
          continue;
        }
        if (!mark.dot) {
          const dot = document.createElement("div");
          dot.className = "rc-gutter-dot";
          gutter.appendChild(dot);
          mark.dot = dot;
        }
        const failed = mark.exitCode !== undefined && mark.exitCode !== 0;
        mark.dot.classList.toggle("rc-gutter-dot-error", failed);
        mark.dot.title =
          mark.exitCode === undefined
            ? "Command"
            : `Exit code: ${mark.exitCode}`;
        mark.dot.style.display = "block";
        mark.dot.style.top = `${Math.round(
          gutterTop + y * cellHeight + (cellHeight - 6) / 2,
        )}px`;
      }
    };

    term.parser.registerOscHandler(133, (data) => {
      if (data === "A") {
        const mark: CommandMark = {
          marker: term.registerMarker(0),
          bufferType: term.buffer.active.type,
        };
        commandMarks.push(mark);
        lastCommandMark = mark;
        // Bound memory: retire the oldest marks, dots included.
        while (commandMarks.length > 500) {
          const old = commandMarks.shift()!;
          old.dot?.remove();
          old.marker.dispose();
        }
      } else if (data.startsWith("D")) {
        const code = Number(data.slice(2));
        if (lastCommandMark && Number.isInteger(code)) {
          lastCommandMark.exitCode = code;
        }
      }
      updateGutter();
      return true;
    });
    const gutterDisposables = [
      term.onScroll(updateGutter),
      term.onRender(updateGutter),
    ];

    // Command navigation: Cmd/Ctrl+Up/Down jumps between command marks.
    // Skipped on the alt screen — tmux panes scroll remotely instead.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !(e.metaKey || e.ctrlKey)) return true;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return true;
      const buf = term.buffer.active;
      if (buf.type !== "normal") return true;
      const cur = buf.viewportY;
      let target: number | undefined;
      if (e.key === "ArrowUp") {
        for (let i = commandMarks.length - 1; i >= 0; i--) {
          const m = commandMarks[i];
          if (
            m.bufferType === "normal" &&
            !m.marker.isDisposed &&
            m.marker.line < cur
          ) {
            target = m.marker.line;
            break;
          }
        }
      } else {
        for (const m of commandMarks) {
          if (
            m.bufferType === "normal" &&
            !m.marker.isDisposed &&
            m.marker.line > cur
          ) {
            target = m.marker.line;
            break;
          }
        }
      }
      if (target === undefined) return true;
      term.scrollToLine(target);
      return false;
    });

    // Rule-based keyword highlighting: after each parsed write, mark matches
    // with xterm decorations — the data stream itself is never modified.
    // Strategy depends on the active buffer:
    //  - normal: incremental. Rows above the cursor row are final, so each
    //    row is scanned exactly once; markers keep decorations attached to
    //    their text across scrollback and rewraps. A flood guard
    //    auto-disables scanning under sustained output.
    //  - alternate (full-screen apps: vim, tmux, …): rows are rewritten in
    //    place, so the whole visible area (bounded by term.rows) is
    //    rescanned every tick and the previous round's decorations are
    //    retired first. No flood guard needed — the row count is bounded.
    let highlightScannedTo = 0; // absolute buffer line scanned up to
    let highlightRaf = 0;
    let highlightDisabledUntil = 0; // flood guard cooldown
    let highlightWindowStart = performance.now();
    let highlightWindowRows = 0;
    let highlightBufferType: "normal" | "alternate" | null = null;
    // Live decorations per buffer, so a rewritten line (full-screen redraw,
    // or `clear` reusing buffer rows) drops the highlight of its old content.
    let normalDecos: IDecoration[] = [];
    let altDecos: IDecoration[] = [];

    const highlightSpans = (y: number, out: IDecoration[]) => {
      const buf = term.buffer.active;
      const line = buf.getLine(y);
      if (!line) return;
      const spans = matchLine(
        line.translateToString(true),
        useAppStore.getState().highlightRules,
      );
      if (spans.length === 0) return;
      const marker = term.registerMarker(y - (buf.baseY + buf.cursorY));
      for (const span of spans) {
        const deco = term.registerDecoration({
          marker,
          x: span.startCol,
          width: span.endCol - span.startCol,
          foregroundColor: resolveHighlightColor(
            span.foreground,
            highlightPaletteRef.current,
          ),
          backgroundColor: resolveHighlightColor(
            span.background,
            highlightPaletteRef.current,
          ),
          layer: "bottom",
        });
        if (deco) out.push(deco);
      }
    };

    const scanNewRows = () => {
      highlightRaf = 0;
      if (!useAppStore.getState().highlightEnabled) return;
      const buf = term.buffer.active;

      if (buf.type !== highlightBufferType) {
        // Buffer switch: never carry tracking across it. The alt buffer is
        // destroyed on the way out (its markers dispose themselves); the
        // normal buffer survives, but full-screen apps may have rewritten
        // nothing or everything, so keep only its still-live decorations.
        for (const d of altDecos) if (!d.isDisposed) d.dispose();
        altDecos = [];
        normalDecos = normalDecos.filter((d) => !d.isDisposed);
        highlightScannedTo = 0;
        highlightBufferType = buf.type;
      }

      if (buf.type === "alternate") {
        for (const d of altDecos) if (!d.isDisposed) d.dispose();
        altDecos = [];
        for (let y = 0; y < term.rows; y++) highlightSpans(y, altDecos);
        return;
      }

      // The cursor row is still mutable; only finalized rows above it.
      const end = buf.baseY + buf.cursorY;
      // Buffer resets (`clear`, full reset) shrink absolute line numbers.
      highlightScannedTo = Math.min(highlightScannedTo, end);
      if (
        performance.now() < highlightDisabledUntil ||
        end <= highlightScannedTo
      ) {
        return;
      }
      // Bound the work per tick; skipped rows simply stay unhighlighted.
      const from = Math.max(
        highlightScannedTo,
        end - HIGHLIGHT_MAX_ROWS_PER_TICK,
      );
      const rows = end - from;

      // Flood guard: sustained output above the threshold auto-disables
      // scanning for a cooldown; if the flood persists, it re-disables.
      const now = performance.now();
      if (now - highlightWindowStart > 1000) {
        highlightWindowStart = now;
        highlightWindowRows = 0;
      }
      highlightWindowRows += rows;
      if (highlightWindowRows > HIGHLIGHT_FLOOD_ROWS_PER_SEC) {
        highlightDisabledUntil = now + HIGHLIGHT_FLOOD_COOLDOWN_MS;
        highlightWindowRows = 0;
        highlightScannedTo = end;
        return;
      }

      for (let y = from; y < end; y++) {
        // Rescanning a line (it was rewritten after `clear`): retire the
        // decorations of its previous content first.
        if (normalDecos.length > 0) {
          normalDecos = normalDecos.filter((d) => {
            if (d.isDisposed) return false;
            if (d.marker.line === y) {
              d.dispose();
              return false;
            }
            return true;
          });
        }
        highlightSpans(y, normalDecos);
      }
      highlightScannedTo = end;
    };

    const scheduleHighlightScan = () => {
      if (highlightRaf !== 0) return;
      highlightRaf = requestAnimationFrame(scanNewRows);
    };
    const highlightDisposable = term.onWriteParsed(scheduleHighlightScan);

    // Persistent (tmux) panes: the frontend owns wheel/selection behavior
    // and drives remote history through the control channel.
    const scroll = new TmuxScrollController(
      () => paneRef.current.connKey,
      () => paneRef.current.tmuxSession,
    );
    term.attachCustomWheelEventHandler((ev) => !scroll.handleWheel(ev));

    const syncSize = () => {
      // Hidden (inactive) containers report zero size; skip then.
      if (container.clientWidth === 0) return;
      fitAddon.fit();
      measureGutter();
      updateGutter();
      const sid = sessionIdRef.current;
      if (!sid) return;
      invoke("session_resize", {
        sessionId: sid,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    };
    syncSizeRef.current = syncSize;
    syncSize();

    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(container);

    const inputDisposable = term.onData((data) => {
      // Typing while scrolled into tmux history must leave copy-mode first,
      // or the keystrokes would drive copy-mode bindings instead of the
      // shell. The cancel rides the same control channel as the scrolls, so
      // it is ordered after them.
      scroll.exitCopyMode();
      useAppStore.getState().sendInput(tabId, pane.id, data);
    });

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      scroll.dispose();
      scrollbarDisposables.forEach((d) => d.dispose());
      gutterDisposables.forEach((d) => d.dispose());
      gutter.remove();
      highlightDisposable.dispose();
      if (highlightRaf !== 0) cancelAnimationFrame(highlightRaf);
      track.remove();
      if (sessionIdRef.current) clearTermStats(sessionIdRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      enqueueRef.current = () => {};
      syncSizeRef.current = () => {};
    };
  }, [tabId, pane.id]);

  // Effect B: subscribe to the backend session's events; re-runs when a
  // reconnect swaps in a fresh session id.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const unlistens: UnlistenFn[] = [];
    (async () => {
      const unData = await listen<string>(`session-data-${sessionId}`, (e) =>
        enqueueRef.current(e.payload),
      );
      const unExit = await listen(`session-exit-${sessionId}`, () => {
        enqueueRef.current("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
        onExitRef.current?.();
      });
      const unDisconnect = await listen(
        `session-disconnect-${sessionId}`,
        () => {
          enqueueRef.current(
            "\r\n\x1b[33m[connection lost — reconnecting…]\x1b[0m\r\n",
          );
          onDisconnectRef.current?.();
        },
      );
      if (cancelled) {
        unData();
        unExit();
        unDisconnect();
      } else {
        unlistens.push(unData, unExit, unDisconnect);
      }
    })();
    // A fresh session starts with a default size; push the real one.
    syncSizeRef.current();
    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
  }, [sessionId]);

  // Refit and refocus when the tab becomes visible again.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container || container.clientWidth === 0) return;
    fit.fit();
    if (sessionId) {
      invoke("session_resize", {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    }
    term.focus();
  }, [active, sessionId]);

  // Retheme already-open terminals when the app theme changes.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = getTheme(themeId).xterm;
    highlightPaletteRef.current = buildHighlightPalette(getTheme(themeId));
  }, [themeId]);

  const status = pane.status ?? "live";
  // Countdown to the next auto-reconnect attempt (drives the overlay text).
  const nextRetryAt = useAppStore((s) => s.nextRetryAtByPane[pane.id]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "reconnecting" || !nextRetryAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [status, nextRetryAt]);
  const retryInSec =
    status === "reconnecting" && nextRetryAt
      ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000))
      : null;
  const overlayButton =
    "rounded border border-(--border) px-3 py-1 text-xs text-(--text) hover:border-(--accent)";

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {status !== "live" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/55">
          {status === "reconnecting" ? (
            <>
              <span className="text-sm text-(--text)">
                Connection lost —{" "}
                {retryInSec !== null && retryInSec > 0
                  ? `retrying in ${retryInSec}s…`
                  : "reconnecting…"}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => void retryReconnect(tabId, pane.id)}
                  className={overlayButton}
                >
                  Retry now
                </button>
                <button
                  onClick={() => cancelReconnect(tabId, pane.id)}
                  className={overlayButton}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-sm text-(--text)">Session disconnected</span>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    const ok = await retryReconnect(tabId, pane.id);
                    if (!ok) setCredDialogOpen(true);
                  }}
                  className={overlayButton}
                >
                  Reconnect
                </button>
                <button
                  onClick={() => useAppStore.getState().closePane(tabId, pane.id)}
                  className={overlayButton}
                >
                  Close pane
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {credDialogOpen && pane.saved && (
        <ConnectDialog
          prefill={pane.saved}
          onClose={() => setCredDialogOpen(false)}
        />
      )}
    </div>
  );
}
