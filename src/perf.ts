/**
 * Lightweight performance instrumentation, enabled in dev builds only.
 *
 * Two signal sources:
 *  - long tasks (>50ms) on the main thread, captured via PerformanceObserver
 *  - per-terminal pipeline stats: event count/bytes, xterm write (parse)
 *    duration, and event-to-painted latency of the data channel
 *
 * Inspect live numbers from the devtools console with `__perf()`. A summary
 * is also logged automatically every 30s when terminal data flowed.
 */

export const PERF_ENABLED = import.meta.env.DEV;

interface TermStats {
  events: number;
  bytes: number;
  writes: number;
  totalWriteMs: number;
  maxWriteMs: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

interface LongTask {
  at: number;
  durationMs: number;
}

const termStats = new Map<string, TermStats>();
const longTasks: LongTask[] = [];
const MAX_LONG_TASKS = 100;

function entry(sessionId: string): TermStats {
  let e = termStats.get(sessionId);
  if (!e) {
    e = {
      events: 0,
      bytes: 0,
      writes: 0,
      totalWriteMs: 0,
      maxWriteMs: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
    };
    termStats.set(sessionId, e);
  }
  return e;
}

/** Record one inbound `session-data-*` event for a terminal. */
export function recordTermEvent(sessionId: string, bytes: number): void {
  if (!PERF_ENABLED) return;
  const e = entry(sessionId);
  e.events += 1;
  e.bytes += bytes;
}

/**
 * Record a completed xterm write: how long the synchronous parse took and
 * how much time passed since the data arrived from the backend.
 */
export function recordTermWrite(
  sessionId: string,
  writeMs: number,
  latencyMs: number,
): void {
  if (!PERF_ENABLED) return;
  const e = entry(sessionId);
  e.writes += 1;
  e.totalWriteMs += writeMs;
  e.maxWriteMs = Math.max(e.maxWriteMs, writeMs);
  e.totalLatencyMs += latencyMs;
  e.maxLatencyMs = Math.max(e.maxLatencyMs, latencyMs);
}

/** Drop stats for a closed terminal session. */
export function clearTermStats(sessionId: string): void {
  if (!PERF_ENABLED) return;
  termStats.delete(sessionId);
}

/** Current snapshot, exposed as `window.__perf()` in dev builds. */
export function perfSnapshot() {
  const terminals = [...termStats.entries()].map(([sessionId, e]) => ({
    sessionId,
    events: e.events,
    kbytes: Math.round(e.bytes / 1024),
    writes: e.writes,
    avgWriteMs: e.writes ? +(e.totalWriteMs / e.writes).toFixed(2) : 0,
    maxWriteMs: +e.maxWriteMs.toFixed(2),
    avgLatencyMs: e.writes ? +(e.totalLatencyMs / e.writes).toFixed(2) : 0,
    maxLatencyMs: +e.maxLatencyMs.toFixed(2),
  }));
  return { terminals, longTasks: [...longTasks] };
}

if (PERF_ENABLED && typeof window !== "undefined") {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 50) continue;
        longTasks.push({ at: Math.round(e.startTime), durationMs: Math.round(e.duration) });
        if (longTasks.length > MAX_LONG_TASKS) longTasks.shift();
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // Long-task observation unsupported: terminal metrics still work.
  }

  (window as unknown as { __perf: typeof perfSnapshot }).__perf = perfSnapshot;

  let lastEventCount = 0;
  window.setInterval(() => {
    const total = [...termStats.values()].reduce((n, e) => n + e.events, 0);
    if (total === lastEventCount) return;
    lastEventCount = total;
    const { terminals, longTasks: tasks } = perfSnapshot();
    if (terminals.length > 0) console.table(terminals);
    if (tasks.length > 0) {
      console.warn(`[perf] ${tasks.length} long task(s) >50ms so far`, tasks.slice(-10));
    }
  }, 30_000);
}
