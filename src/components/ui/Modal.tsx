import { useEffect, type ReactNode } from "react";

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** Card classes: size, height and padding are the caller's choice. */
  className?: string;
}

/**
 * Centered modal: dimmed overlay + elevated card. Escape (capture phase, so
 * it works above a focused xterm) and backdrop clicks dismiss it; the card
 * itself stops propagation so forms stay interactive.
 */
export default function Modal({ onClose, children, className = "" }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`rc-elevate flex overflow-hidden rounded-xl border border-(--border) bg-(--panel) shadow-2xl ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
