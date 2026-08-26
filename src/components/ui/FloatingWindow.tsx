import { useRef, useState, type ReactNode } from "react";
import MdiIcon from "@mdi/react";
import { mdiClose } from "@mdi/js";

interface FloatingWindowProps {
  title: ReactNode;
  /** Extra header controls (save button, status text, …). */
  actions?: ReactNode;
  onClose: () => void;
  /** Raise this window above its siblings (fired on drag/click). */
  onFocus: () => void;
  /** Stacking order relative to other floating windows. */
  z: number;
  initialX: number;
  initialY: number;
  initialWidth?: number;
  initialHeight?: number;
  children: ReactNode;
}

const MIN_W = 360;
const MIN_H = 220;

/**
 * Modeless floating panel: drag by the title bar, resize from the bottom-right
 * corner. Unlike Modal it has no backdrop, so the rest of the app stays
 * fully interactive while the window is open. Position is clamped so a
 * window can never be dragged entirely out of sight.
 */
export default function FloatingWindow({
  title,
  actions,
  onClose,
  onFocus,
  z,
  initialX,
  initialY,
  initialWidth = 680,
  initialHeight = 480,
  children,
}: FloatingWindowProps) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const [size, setSize] = useState({ w: initialWidth, h: initialHeight });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(
    null,
  );
  const resize = useRef<{ px: number; py: number; w: number; h: number } | null>(
    null,
  );

  const clampPos = (x: number, y: number) => ({
    x: Math.max(-size.w + 120, Math.min(x, window.innerWidth - 120)),
    y: Math.max(0, Math.min(y, window.innerHeight - 40)),
  });

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // Only the primary button drags; buttons in the header are excluded by
    // checking the event target below.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    onFocus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
  };

  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos(clampPos(d.x + e.clientX - d.px, d.y + e.clientY - d.py));
  };

  const onResizePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    e.currentTarget.setPointerCapture(e.pointerId);
    resize.current = { px: e.clientX, py: e.clientY, w: size.w, h: size.h };
  };

  const onResizePointerMove = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r) return;
    setSize({
      w: Math.max(MIN_W, Math.min(r.w + e.clientX - r.px, window.innerWidth - pos.x)),
      h: Math.max(MIN_H, Math.min(r.h + e.clientY - r.py, window.innerHeight - pos.y)),
    });
  };

  return (
    <div
      // Any click inside raises the window; drag adds finer control.
      onPointerDown={onFocus}
      className="rc-elevate fixed flex flex-col overflow-hidden rounded-xl border border-(--border) bg-(--panel) shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, zIndex: z }}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => setSize({ w: initialWidth, h: initialHeight })}
        className="flex h-10 shrink-0 cursor-grab touch-none items-center justify-between gap-3 border-b border-(--border) bg-(--panel-alt) px-3 select-none active:cursor-grabbing"
        title="Drag to move · double-click to reset size"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-(--text)">
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <button
            onClick={onClose}
            className="rounded p-1 text-(--text-dim) hover:bg-(--hover-strong) hover:text-(--text)"
            title="Close"
          >
            <MdiIcon path={mdiClose} size="16px" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {/* Resize handle */}
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={() => (resize.current = null)}
        onPointerCancel={() => (resize.current = null)}
        className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none"
        title="Resize"
      >
        <svg viewBox="0 0 16 16" className="h-full w-full text-(--text-dim)">
          <path
            d="M14 5 L5 14 M14 10 L10 14"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
        </svg>
      </div>
    </div>
  );
}
