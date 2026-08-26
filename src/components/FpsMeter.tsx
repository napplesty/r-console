import { useEffect, useRef } from "react";
import { useAppStore } from "../state/store";

/**
 * FPS overlay for performance diagnostics (Settings → Behavior). Samples
 * requestAnimationFrame timestamps over a rolling window and writes the
 * value straight into the DOM node — React state at 60Hz would pollute the
 * very signal being measured. Also flags frame drops (red) and marginal
 * rates (amber) so regressions are visible at a glance.
 */
export default function FpsMeter() {
  const enabled = useAppStore((s) => s.fpsOverlay);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    const el = ref.current;

    const tick = (now: number) => {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= 500 && el) {
        const fps = Math.round((frames * 1000) / elapsed);
        el.textContent = `${fps} fps`;
        const cls =
          fps >= 55
            ? "text-green-400"
            : fps >= 30
              ? "text-amber-400"
              : "text-red-400";
        el.className = `font-mono text-xs ${cls}`;
        frames = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <span
      ref={ref}
      className="pointer-events-none fixed right-3 bottom-9 z-40 rounded bg-black/60 px-1.5 py-0.5 font-mono text-xs text-(--text-dim)"
    >
      — fps
    </span>
  );
}
