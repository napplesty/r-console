/**
 * Wheel-scroll controller for persistent (tmux) SSH panes.
 *
 * The frontend owns mouse behavior; tmux runs with `mouse off`. Wheel
 * events are intercepted before xterm sees them and translated into tmux
 * copy-mode scroll commands, so scrolling through remote history feels
 * like a plain SSH session while text selection stays fully native (no
 * Shift needed).
 *
 * Transport: commands go over a persistent per-connection control channel
 * (a shell loop executing one `tmux` line each), fire-and-forget — no
 * channel/shell setup per batch, which is what made scrolling laggy.
 *
 * Protocol: every flush sends `copy-mode -e -t NAME ; send-keys -X -N n
 * scroll-{up,down}`. Entering copy-mode while already in it is a silent
 * no-op in tmux (cmd-copy-mode.c returns success without touching the
 * view), and `-e` auto-exits at the bottom, so the controller needs no
 * state synchronization with the server.
 *
 * Note: xterm's own screen/mouse state is useless behind tmux — tmux
 * keeps the outer terminal in the alternate screen permanently and
 * swallows the inner app's mouse reporting — so the wheel ALWAYS drives
 * copy-mode scroll here.
 */
import { invoke } from "@tauri-apps/api/core";

/** Pixel delta roughly equal to one text line, for wheel normalization. */
const PX_PER_LINE = 33;
/** Lines per "page" for page-mode wheel deltas. */
const LINES_PER_PAGE = 10;
/** Wheel batches are flushed at most this often; deltas coalesce between
 * flushes, so fast scrolling scrolls more lines per command. */
const FLUSH_MS = 40;

export class TmuxScrollController {
  /** Conservative copy-mode hint for input handling: true after any scroll
   * until we cancel; a stale true only costs a harmless extra cancel. */
  private scrolled = false;
  /** Accumulated wheel lines not yet sent (positive = up into history). */
  private pending = 0;
  /** Sub-line wheel remainder carried between events. */
  private fraction = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getConnKey: () => string | undefined,
    private readonly getTmuxSession: () => string | undefined,
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
   * xterm must not process it further. Shift bypasses the interception: the
   * event then reaches xterm, which forwards it to the app when it requested
   * mouse reporting, or converts it to arrow keys on the alt screen (e.g.
   * paging in `less`). Needed for alt-screen apps whose output never enters
   * tmux history, where copy-mode scrolling has nothing to show.
   */
  handleWheel(e: WheelEvent): boolean {
    if (e.shiftKey) return false;
    if (!this.getConnKey() || !this.getTmuxSession()) return false;
    const lines = this.linesOf(e);
    if (lines === 0) return true;
    const idle = this.pending === 0 && this.timer === null;
    this.pending += lines;
    if (idle) this.flush(); // first tick responds immediately
    this.scheduleFlush();
    return true;
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending !== 0) {
        this.flush();
        this.scheduleFlush();
      }
    }, FLUSH_MS);
  }

  /** Send one tmux command line over the control channel. */
  private send(line: string): void {
    const connKey = this.getConnKey();
    if (!connKey) return;
    invoke("tmux_control_send", { connKey, line }).catch((err) =>
      console.warn("[tmux-scroll] control write failed:", err),
    );
  }

  private flush(): void {
    const n = this.pending;
    this.pending = 0;
    if (n === 0) return;
    const name = this.getTmuxSession();
    if (!name) return;
    this.scrolled = true;
    this.send(
      `copy-mode -e -t ${name} \\; send-keys -t ${name} -X -N ${Math.abs(n)} ${
        n > 0 ? "scroll-up" : "scroll-down"
      }`,
    );
  }

  /** Leave copy-mode before forwarding typed input to the shell. */
  exitCopyMode(): void {
    if (!this.scrolled) return;
    this.scrolled = false;
    const name = this.getTmuxSession();
    if (name) this.send(`send-keys -t ${name} -X cancel`);
  }

  /** Stop the flush timer (pane unmount). */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
