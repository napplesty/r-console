import { useEffect, type ReactNode } from "react";
import MdiIcon from "@mdi/react";

interface MenuProps {
  /** Anchor point in viewport coordinates (typically a button's rect). */
  x: number;
  y: number;
  onClose: () => void;
  /** Menu width in px, also used to keep the menu on screen. */
  width?: number;
  /** Extra card classes (e.g. max-height with overflow-y-auto). */
  className?: string;
  children: ReactNode;
}

/**
 * Anchored dropdown menu: fixed-position elevated card with click-away and
 * Escape dismissal. Position is clamped so the menu never leaves the
 * viewport horizontally.
 */
export function Menu({
  x,
  y,
  onClose,
  width = 208,
  className = "",
  children,
}: MenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
  const top = Math.min(y, window.innerHeight - 32);

  return (
    <>
      {/* Click-away layer closing the menu */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className={`rc-elevate rc-menu fixed z-50 rounded-lg border border-(--border) bg-(--panel-alt) py-1 shadow-2xl ${className}`}
        style={{ left, top, width }}
      >
        {children}
      </div>
    </>
  );
}

interface MenuItemProps {
  icon?: string;
  label: ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false,
  title,
}: MenuItemProps) {
  return (
    <button
      onClick={(e) => {
        if (!disabled) onClick(e);
      }}
      disabled={disabled}
      title={title}
      className={`rc-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
        danger ? "text-red-400" : "text-(--text)"
      } ${disabled ? "cursor-default opacity-40" : ""}`}
    >
      {icon && <MdiIcon path={icon} size="14px" className="shrink-0" />}
      {label}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 border-t border-(--border)" />;
}
