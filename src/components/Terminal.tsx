import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../state/store";
import { getTheme } from "../lib/themes";
import { clearTermStats, recordTermEvent, recordTermWrite } from "../lib/perf";
import { cancelReconnect, retryReconnect } from "../state/sessions";
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
      // shell.
      if (scroll.isScrolled()) {
        void scroll
          .exitCopyMode()
          .then(() => useAppStore.getState().sendInput(tabId, pane.id, data));
      } else {
        useAppStore.getState().sendInput(tabId, pane.id, data);
      }
    });

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
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
  }, [themeId]);

  const status = pane.status ?? "live";
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
                Connection lost — reconnecting…
              </span>
              <button
                onClick={() => cancelReconnect(tabId, pane.id)}
                className={overlayButton}
              >
                Cancel
              </button>
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
