import { useLayoutEffect, useRef, useState } from "react";
import MdiIcon from "@mdi/react";
import {
  mdiBroadcast,
  mdiConsole,
  mdiContentDuplicate,
  mdiDotsVertical,
  mdiSsh,
  mdiViewSplitHorizontal,
  mdiViewSplitVertical,
} from "@mdi/js";
import { activePane, useAppStore } from "../state/store";
import {
  openLocalTab,
  resolveSavedSessionConfig,
  splitActivePane,
  splitTabWithLocal,
  splitTabWithSsh,
  sshConfigAsSaved,
  tryConnectSaved,
} from "../state/sessions";
import { THEMES } from "../lib/themes";
import ConnectDialog from "./ConnectDialog";
import type { SavedSession, SplitDirection } from "../lib/types";

/** Where the split-target dropdown is anchored, and for which direction. */
interface SplitMenuState {
  direction: SplitDirection;
  x: number;
  y: number;
}

/** Pixel width of the "⋯" overflow dropdown (Tailwind w-60). */
const OVERFLOW_MENU_WIDTH = 240;

export default function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const toggleBroadcast = useAppStore((s) => s.toggleBroadcast);
  const themeId = useAppStore((s) => s.themeId);
  const setThemeId = useAppStore((s) => s.setThemeId);
  const scrollback = useAppStore((s) => s.scrollback);
  const setScrollback = useAppStore((s) => s.setScrollback);
  const followCwd = useAppStore((s) => s.followCwd);
  const setFollowCwd = useAppStore((s) => s.setFollowCwd);
  const highlightEnabled = useAppStore((s) => s.highlightEnabled);
  const setHighlightEnabled = useAppStore((s) => s.setHighlightEnabled);
  const savedSessions = useAppStore((s) => s.savedSessions);
  const sshConfigHosts = useAppStore((s) => s.sshConfigHosts);

  const [splitMenu, setSplitMenu] = useState<SplitMenuState | null>(null);
  const [splitDialog, setSplitDialog] = useState<{
    prefill: SavedSession | null;
    direction: SplitDirection;
  } | null>(null);
  // Inline tab-group renaming: id of the tab being edited plus draft value.
  const [renaming, setRenaming] = useState<{
    id: string;
    value: string;
  } | null>(null);
  // Overflow handling: when the row is too narrow, the secondary toolbar
  // controls (split/broadcast/scrollback/follow-cwd/theme) collapse into a
  // single "⋯" dropdown. The tab strip and the "+" button always stay put.
  const [collapsed, setCollapsed] = useState(false);
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // The "+" button's new-session dropdown, and the connect dialog it can open.
  const [newTabMenu, setNewTabMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [newConnOpen, setNewConnOpen] = useState(false);
  const [newConnPrefill, setNewConnPrefill] = useState<SavedSession | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  // Natural width of the expanded controls, remembered so we can decide when
  // to expand again while they are hidden in the collapsed state.
  const controlsWidthRef = useRef(0);

  // Re-evaluate expanded vs. collapsed whenever the row (or the tab count)
  // changes size.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      if (!collapsed && controlsRef.current) {
        controlsWidthRef.current = controlsRef.current.offsetWidth;
      }
      const controlsW = controlsWidthRef.current || 320;
      // Reserve room for the tab strip: at least one tab's minimum width,
      // capped so a long tab list scrolls instead of forcing the controls out.
      const tabsNatural = tabsRef.current?.scrollWidth ?? 0;
      const tabsW = Math.min(Math.max(tabsNatural, 120), 360);
      const need =
        tabsW + 28 /* "+" button */ + controlsW + 16 /* px-2 */ + 12 /* gaps */;
      const fits = need <= container.clientWidth;
      // Hysteresis: once collapsed, require extra slack before expanding again
      // so the row does not flicker around the breakpoint.
      const next = !fits || (collapsed && container.clientWidth < need + 32);
      if (!next) setOverflowMenu(null);
      if (next !== collapsed) setCollapsed(next);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => ro.disconnect();
  }, [collapsed, tabs.length]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const noActiveTab = !activeTab;

  const actionButtonClass = (disabled: boolean) =>
    `rounded p-1 ${
      disabled
        ? "cursor-default opacity-40"
        : "text-(--text-dim) hover:bg-white/5 hover:text-(--text)"
    }`;

  const openSplitMenu = (
    e: React.MouseEvent<HTMLButtonElement>,
    direction: SplitDirection,
  ) => {
    if (noActiveTab) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setSplitMenu({ direction, x: rect.left, y: rect.bottom + 4 });
  };

  // Connect a saved/configured host as a new pane of the active tab. When
  // credentials cannot be resolved silently, fall back to the connect dialog
  // in split mode.
  const splitToSession = async (
    s: SavedSession,
    direction: SplitDirection,
  ) => {
    setSplitMenu(null);
    if (!activeTabId) return;
    const config = await resolveSavedSessionConfig(s);
    if (config) {
      try {
        await splitTabWithSsh(activeTabId, direction, config, s.name, s);
        return;
      } catch (err) {
        console.error("SSH split connect failed:", err);
      }
    }
    setSplitDialog({ prefill: s, direction });
  };

  // Connect a saved/configured host as a new tab; fall back to the prefilled
  // connect dialog when credentials cannot be resolved silently.
  const connectSavedAsTab = async (s: SavedSession) => {
    setNewTabMenu(null);
    if (!(await tryConnectSaved(s))) {
      setNewConnPrefill(s);
      setNewConnOpen(true);
    }
  };

  const menuItemClass =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-(--text) hover:bg-white/5";

  return (
    <div
      ref={containerRef}
      className="flex h-10 shrink-0 items-center gap-1 border-b border-(--border) px-2 select-none"
    >
      {/* Tab strip: scrolls horizontally (scrollbar hidden) so tabs never
          crush the toolbar controls on the right. */}
      <div
        ref={tabsRef}
        className="rc-tabs-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`group flex min-w-[120px] max-w-[240px] cursor-pointer items-center gap-2 rounded px-3 py-1 text-sm ${
              tab.id === activeTabId
                ? "bg-(--panel-alt) text-(--text)"
                : "text-(--text-dim) hover:bg-white/5"
            }`}
          >
            {tab.broadcast && (
              <MdiIcon
                path={mdiBroadcast}
                size="14px"
                className="shrink-0 text-(--accent)"
              />
            )}
            <MdiIcon
              path={activePane(tab).kind === "ssh" ? mdiSsh : mdiConsole}
              size="14px"
              className="shrink-0"
            />
            {renaming?.id === tab.id ? (
              <input
                autoFocus
                value={renaming.value}
                onChange={(e) =>
                  setRenaming({ id: tab.id, value: e.target.value })
                }
                onBlur={() => {
                  const title = renaming.value.trim();
                  if (title) renameTab(tab.id, title);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-28 rounded border border-(--accent) bg-transparent px-1 py-0 text-sm text-(--text) outline-none"
              />
            ) : (
              <span
                className="min-w-0 flex-1 truncate"
                title="Double-click to rename this tab group"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenaming({ id: tab.id, value: tab.title });
                }}
              >
                {tab.title}
              </span>
            )}
            {/* Persistent (tmux-backed) panes get a subtle badge; the tooltip
                lists the remote tmux session names. */}
            {tab.panes.some((p) => p.tmuxSession) && (
              <span
                className="shrink-0 rounded border border-(--accent) px-1 text-[10px] leading-4 text-(--accent)"
                title={`Persistent tmux: ${[
                  ...new Set(
                    tab.panes.map((p) => p.tmuxSession).filter(Boolean),
                  ),
                ].join(", ")}`}
              >
                tmux
              </span>
            )}
            {tab.panes.length > 1 && (
              <span className="shrink-0 text-xs text-(--text-dim)">
                ×{tab.panes.length}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="rounded px-1 text-(--text-dim) opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-(--text)"
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setNewTabMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        className="shrink-0 rounded px-2 py-1 text-(--text-dim) hover:bg-white/5 hover:text-(--text)"
        title="New session"
      >
        +
      </button>
      {collapsed ? (
        <button
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOverflowMenu({
              x: Math.max(4, rect.right - OVERFLOW_MENU_WIDTH),
              y: rect.bottom + 4,
            });
          }}
          className="shrink-0 rounded p-1 text-(--text-dim) hover:bg-white/5 hover:text-(--text)"
          title="More tab actions"
        >
          <MdiIcon path={mdiDotsVertical} size="16px" />
        </button>
      ) : (
        <div ref={controlsRef} className="flex shrink-0 items-center gap-1">
          <button
            onClick={(e) => openSplitMenu(e, "horizontal")}
            className={actionButtonClass(noActiveTab)}
            title="Split right (choose target host)"
          >
            <MdiIcon path={mdiViewSplitVertical} size="16px" />
          </button>
          <button
            onClick={(e) => openSplitMenu(e, "vertical")}
            className={actionButtonClass(noActiveTab)}
            title="Split down (choose target host)"
          >
            <MdiIcon path={mdiViewSplitHorizontal} size="16px" />
          </button>
          <button
            onClick={() => {
              if (noActiveTab) return;
              toggleBroadcast(activeTabId!);
            }}
            className={`rounded p-1 ${
              noActiveTab
                ? "cursor-default opacity-40"
                : activeTab.broadcast
                  ? "text-(--accent) hover:bg-white/5"
                  : "text-(--text-dim) hover:bg-white/5 hover:text-(--text)"
            }`}
            title="Broadcast input to all panes (MultiExec)"
          >
            <MdiIcon path={mdiBroadcast} size="16px" />
          </button>
          <label
            className="flex shrink-0 items-center gap-1 text-xs text-(--text-dim)"
            title="Scrollback lines (applies to terminals opened afterwards)"
          >
            Scrollback
            <input
              type="number"
              min={100}
              step={1000}
              value={scrollback}
              onChange={(e) => setScrollback(Number(e.target.value))}
              className="w-20 rounded border border-(--border) bg-transparent px-1.5 py-0.5 text-(--text-dim) outline-none focus:border-(--accent)"
            />
          </label>
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-(--text-dim) hover:text-(--text)"
            title="Let the SFTP panel follow the terminal's working directory (OSC 7)"
          >
            <input
              type="checkbox"
              checked={followCwd}
              onChange={(e) => setFollowCwd(e.target.checked)}
              className="accent-(--accent)"
            />
            Follow cwd
          </label>
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-(--text-dim) hover:text-(--text)"
            title="Highlight keywords (errors, warnings, IPs) in terminal output"
          >
            <input
              type="checkbox"
              checked={highlightEnabled}
              onChange={(e) => setHighlightEnabled(e.target.checked)}
              className="accent-(--accent)"
            />
            Highlight
          </label>
          <select
            value={themeId}
            onChange={(e) => setThemeId(e.target.value)}
            className="shrink-0 cursor-pointer rounded border border-(--border) bg-transparent px-1.5 py-0.5 text-xs text-(--text-dim) hover:text-(--text)"
            title="Color theme"
          >
            {Object.values(THEMES).map((theme) => (
              <option
                key={theme.id}
                value={theme.id}
                className="bg-(--panel-alt) text-(--text)"
              >
                {theme.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {overflowMenu && (
        <>
          {/* Click-away layer closing the menu; inputs below stay usable
              because they sit inside the panel above this layer. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOverflowMenu(null)}
          />
          <div
            className="fixed z-50 w-60 rounded border border-(--border) bg-(--panel-alt) py-1 shadow-xl"
            style={{ left: overflowMenu.x, top: overflowMenu.y }}
          >
            <button
              onClick={(e) => {
                if (noActiveTab) return;
                openSplitMenu(e, "horizontal");
                setOverflowMenu(null);
              }}
              className={`${menuItemClass} ${noActiveTab ? "cursor-default opacity-40" : ""}`}
              title="Split right (choose target host)"
            >
              <MdiIcon path={mdiViewSplitVertical} size="14px" />
              Split right…
            </button>
            <button
              onClick={(e) => {
                if (noActiveTab) return;
                openSplitMenu(e, "vertical");
                setOverflowMenu(null);
              }}
              className={`${menuItemClass} ${noActiveTab ? "cursor-default opacity-40" : ""}`}
              title="Split down (choose target host)"
            >
              <MdiIcon path={mdiViewSplitHorizontal} size="14px" />
              Split down…
            </button>
            <button
              onClick={() => {
                if (noActiveTab) return;
                toggleBroadcast(activeTabId!);
              }}
              className={`${menuItemClass} ${noActiveTab ? "cursor-default opacity-40" : ""}`}
              title="Broadcast input to all panes (MultiExec)"
            >
              <MdiIcon
                path={mdiBroadcast}
                size="14px"
                className={activeTab?.broadcast ? "text-(--accent)" : ""}
              />
              Broadcast input to all panes
            </button>
            <label
              className="mt-1 flex items-center justify-between gap-2 border-t border-(--border) px-3 py-1.5 text-xs text-(--text-dim)"
              title="Scrollback lines (applies to terminals opened afterwards)"
            >
              Scrollback
              <input
                type="number"
                min={100}
                step={1000}
                value={scrollback}
                onChange={(e) => setScrollback(Number(e.target.value))}
                className="w-20 rounded border border-(--border) bg-transparent px-1.5 py-0.5 text-(--text-dim) outline-none focus:border-(--accent)"
              />
            </label>
            <label
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-(--text-dim) hover:text-(--text)"
              title="Let the SFTP panel follow the terminal's working directory (OSC 7)"
            >
              <input
                type="checkbox"
                checked={followCwd}
                onChange={(e) => setFollowCwd(e.target.checked)}
                className="accent-(--accent)"
              />
              Follow cwd
            </label>
            <label
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-(--text-dim) hover:text-(--text)"
              title="Highlight keywords (errors, warnings, IPs) in terminal output"
            >
              <input
                type="checkbox"
                checked={highlightEnabled}
                onChange={(e) => setHighlightEnabled(e.target.checked)}
                className="accent-(--accent)"
              />
              Highlight
            </label>
            <label
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-(--text-dim)"
              title="Color theme"
            >
              Theme
              <select
                value={themeId}
                onChange={(e) => setThemeId(e.target.value)}
                className="cursor-pointer rounded border border-(--border) bg-transparent px-1.5 py-0.5 text-xs text-(--text-dim) hover:text-(--text)"
              >
                {Object.values(THEMES).map((theme) => (
                  <option
                    key={theme.id}
                    value={theme.id}
                    className="bg-(--panel-alt) text-(--text)"
                  >
                    {theme.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}

      {newTabMenu && (
        <>
          {/* Click-away layer closing the menu */}
          <div className="fixed inset-0 z-40" onClick={() => setNewTabMenu(null)} />
          <div
            className="fixed z-50 max-h-80 w-56 overflow-y-auto rounded border border-(--border) bg-(--panel-alt) py-1 shadow-xl"
            style={{ left: newTabMenu.x, top: newTabMenu.y }}
          >
            <button
              onClick={() => {
                setNewTabMenu(null);
                openLocalTab().catch(() => {});
              }}
              className={menuItemClass}
            >
              <MdiIcon path={mdiConsole} size="14px" />
              Local terminal
            </button>
            <button
              onClick={() => {
                setNewTabMenu(null);
                setNewConnPrefill(null);
                setNewConnOpen(true);
              }}
              className={menuItemClass}
            >
              <MdiIcon path={mdiSsh} size="14px" />
              SSH connection…
            </button>

            {savedSessions.length > 0 && (
              <p className="mt-1 border-t border-(--border) px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
                Saved
              </p>
            )}
            {savedSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => connectSavedAsTab(s)}
                className={menuItemClass}
                title={`${s.username}@${s.host}:${s.port}`}
              >
                <MdiIcon path={mdiSsh} size="14px" />
                <span className="truncate">{s.name}</span>
              </button>
            ))}

            {sshConfigHosts.length > 0 && (
              <p className="mt-1 border-t border-(--border) px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
                From ~/.ssh/config
              </p>
            )}
            {sshConfigHosts.map((h) => (
              <button
                key={h.alias}
                onClick={() => connectSavedAsTab(sshConfigAsSaved(h))}
                className={menuItemClass}
                title={`${h.user ? `${h.user}@` : ""}${h.hostName}:${h.port ?? 22}`}
              >
                <MdiIcon path={mdiSsh} size="14px" />
                <span className="truncate">{h.alias}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {newConnOpen && (
        <ConnectDialog
          prefill={newConnPrefill}
          onClose={() => setNewConnOpen(false)}
        />
      )}

      {splitMenu && activeTab && (
        <>
          {/* Click-away layer closing the menu */}
          <div className="fixed inset-0 z-40" onClick={() => setSplitMenu(null)} />
          <div
            className="fixed z-50 max-h-80 w-56 overflow-y-auto rounded border border-(--border) bg-(--panel-alt) py-1 shadow-xl"
            style={{ left: splitMenu.x, top: splitMenu.y }}
          >
            <p className="px-3 pt-1 pb-0.5 text-xs font-medium text-(--text-dim)">
              Split {splitMenu.direction === "horizontal" ? "right" : "down"} with
            </p>
            <button
              onClick={() => {
                const { direction } = splitMenu;
                setSplitMenu(null);
                splitActivePane(direction).catch((e) => console.error(e));
              }}
              className={menuItemClass}
            >
              <MdiIcon path={mdiContentDuplicate} size="14px" />
              Duplicate current pane
            </button>
            <button
              onClick={() => {
                const { direction } = splitMenu;
                setSplitMenu(null);
                splitTabWithLocal(activeTabId!, direction).catch((e) =>
                  console.error(e),
                );
              }}
              className={menuItemClass}
            >
              <MdiIcon path={mdiConsole} size="14px" />
              Local terminal
            </button>

            {savedSessions.length > 0 && (
              <p className="px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
                Saved
              </p>
            )}
            {savedSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => splitToSession(s, splitMenu.direction)}
                className={menuItemClass}
                title={`${s.username}@${s.host}:${s.port}`}
              >
                <MdiIcon path={mdiSsh} size="14px" />
                <span className="truncate">{s.name}</span>
              </button>
            ))}

            {sshConfigHosts.length > 0 && (
              <p className="px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
                From ~/.ssh/config
              </p>
            )}
            {sshConfigHosts.map((h) => (
              <button
                key={h.alias}
                onClick={() =>
                  splitToSession(sshConfigAsSaved(h), splitMenu.direction)
                }
                className={menuItemClass}
                title={`${h.user ? `${h.user}@` : ""}${h.hostName}:${h.port ?? 22}`}
              >
                <MdiIcon path={mdiSsh} size="14px" />
                <span className="truncate">{h.alias}</span>
              </button>
            ))}

            <button
              onClick={() => {
                const { direction } = splitMenu;
                setSplitMenu(null);
                setSplitDialog({ prefill: null, direction });
              }}
              className={`${menuItemClass} mt-1 border-t border-(--border)`}
            >
              <MdiIcon path={mdiSsh} size="14px" />
              Other SSH connection…
            </button>
          </div>
        </>
      )}

      {splitDialog && activeTabId && (
        <ConnectDialog
          prefill={splitDialog.prefill}
          split={{ tabId: activeTabId, direction: splitDialog.direction }}
          onClose={() => setSplitDialog(null)}
        />
      )}
    </div>
  );
}
