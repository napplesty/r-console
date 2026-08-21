/**
 * Wheel-scroll controller for persistent (tmux) SSH panes.
 *
 * The frontend owns mouse behavior; tmux runs with `mouse off`. Wheel
 * events are intercepted before xterm sees them and translated into tmux
 * copy-mode scroll commands over a dedicated control channel, so scrolling
 * through remote history feels like a plain SSH session while text
 * selection stays fully native (no Shift needed).
 *
 * Corner cases handled here:
 *  - apps with mouse reporting (vim, htop) keep owning the mouse;
 *  - alternate-screen apps without mouse (less) get iTerm-style
 *    "alternate scroll": wheel becomes arrow keys;
 *  - copy-mode state is tracked optimistically and re-synced on errors
 *    (copy-mode -e auto-exits at the bottom; reconnects reset the view).
 */
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

/** Pixel delta roughly equal to one text line, for wheel normalization. */
const PX_PER_LINE = 33;
/** Lines per "page" for page-mode wheel deltas. */
const LINES_PER_PAGE = 10;
/** Arrow-key sequences for alternate scroll (normal / application mode). */
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_UP_APP = "\x1bOA";
const KEY_DOWN_APP = "\x1bOB";

export class TmuxScrollController {
  /** Whether we believe tmux is in copy-mode; re-synced on command errors. */
  private scrolled = false;
  /** Accumulated wheel lines not yet sent (positive = up into history). */
  private pending = 0;
  /** Sub-line wheel remainder carried between events. */
  private fraction = 0;
  /** One control command in flight at a time; batches coalesce. */
  private inFlight = false;

  constructor(
    private readonly getConnKey: () => string | undefined,
    private readonly getTmuxSession: () => string | undefined,
    private readonly sendInput: (data: string) => void,
  ) {}

  isScrolled(): boolean {
    return this.scrolled;
  }

  /** Normalize a wheel event to whole lines (signed; up = positive). */
  private linesOf(e: WheelEvent): number {
    let lines: number;
    if (e.deltaMode === 1) lines = -e.deltaY;
    else if (e.deltaMode === 2) lines = -e.deltaY * LINES_PER_PAGE;
    else lines = -e.deltaY / PX_PER_LINE;
    this.fraction += lines;
    const whole = Math.trunc(this.fraction);
    this.fraction -= whole;
    return whole;
  }

  /**
   * Consume a wheel event. Returns true when the event was handled here and
   * xterm must not process it further.
   */
  handleWheel(e: WheelEvent, term: Terminal): boolean {
    if (!this.getConnKey() || !this.getTmuxSession()) return false;
    // Applications that requested mouse reporting (vim, htop) own the mouse.
    if (term.modes.mouseTrackingMode !== "none") return false;

    const lines = this.linesOf(e);
    if (lines === 0) return true;

    if (term.buffer.active.type === "alternate") {
      // Alternate scroll for pagers like less: wheel as arrow keys.
      const appMode = term.modes.applicationCursorKeysMode;
      const key =
        lines > 0
          ? appMode
            ? KEY_UP_APP
            : KEY_UP
          : appMode
            ? KEY_DOWN_APP
            : KEY_DOWN;
      this.sendInput(key.repeat(Math.abs(lines)));
      return true;
    }

    this.pending += lines;
    void this.pump();
    return true;
  }

  /** Flush accumulated wheel lines to tmux, one control command at a time. */
  private async pump(): Promise<void> {
    if (this.inFlight || this.pending === 0) return;
    const connKey = this.getConnKey();
    const name = this.getTmuxSession();
    if (!connKey || !name) {
      this.pending = 0;
      return;
    }
    const n = this.pending;
    this.pending = 0;
    this.inFlight = true;
    const scroll = `send-keys -t ${name} -X -N ${Math.abs(n)} ${
      n > 0 ? "scroll-up" : "scroll-down"
    }`;
    try {
      if (this.scrolled) {
        // `-e` auto-exits copy-mode when scrolling back to the bottom.
        await invoke("tmux_control", { connKey, args: scroll });
      } else {
        await invoke("tmux_control", {
          connKey,
          args: `copy-mode -e -t ${name} \\; ${scroll}`,
        });
      }
      this.scrolled = true;
    } catch {
      if (this.scrolled) {
        // Bare scroll failed: not actually in copy-mode (auto-exited at the
        // bottom, or a reconnect reset the view). Re-enter next batch.
        this.scrolled = false;
      } else {
        // Entry failed: either already in copy-mode (older tmux rejects a
        // second `copy-mode`) or tmux is gone. Probe with the bare scroll.
        try {
          await invoke("tmux_control", { connKey, args: scroll });
          this.scrolled = true;
        } catch {
          this.scrolled = false;
        }
      }
    }
    this.inFlight = false;
    if (this.pending !== 0) void this.pump();
  }

  /** Leave copy-mode before forwarding typed input to the shell. */
  async exitCopyMode(): Promise<void> {
    if (!this.scrolled) return;
    const connKey = this.getConnKey();
    const name = this.getTmuxSession();
    this.scrolled = false;
    if (!connKey || !name) return;
    await invoke("tmux_control", {
      connKey,
      args: `send-keys -t ${name} -X cancel`,
    }).catch(() => {});
  }
}
