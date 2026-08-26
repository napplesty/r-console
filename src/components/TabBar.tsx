import { useLayoutEffect, useRef, useState } from "react";
import MdiIcon from "@mdi/react";
import {
  mdiBroadcast,
  mdiCogOutline,
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
import ConnectDialog from "./ConnectDialog";
import { Menu, MenuItem, MenuDivider } from "./ui/Menu";
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
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
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
  // controls (split/broadcast/settings) collapse into a single "⋯"
  // dropdown. The tab strip and the "+" button always stay put.
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
        : "text-(--text-dim) hover:bg-(--hover) hover:text-(--text)"
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
            className={`group flex min-w-[120px] max-w-[240px] cursor-pointer items-center gap-2 rounded-md px-3 py-1 text-sm transition-colors ${
              tab.id === activeTabId
                ? "bg-(--panel-alt) text-(--text) shadow-[inset_0_2px_0_0_var(--accent)]"
                : "text-(--text-dim) hover:bg-(--hover) hover:text-(--text)"
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
              className="rounded px-1 text-(--text-dim) opacity-0 group-hover:opacity-100 hover:bg-(--hover-strong) hover:text-(--text)"
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
        className="shrink-0 rounded px-2 py-1 text-(--text-dim) hover:bg-(--hover) hover:text-(--text)"
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
          className="shrink-0 rounded p-1 text-(--text-dim) hover:bg-(--hover) hover:text-(--text)"
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
                  ? "text-(--accent) hover:bg-(--hover)"
                  : "text-(--text-dim) hover:bg-(--hover) hover:text-(--text)"
            }`}
            title="Broadcast input to all panes (MultiExec)"
          >
            <MdiIcon path={mdiBroadcast} size="16px" />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded p-1 text-(--text-dim) hover:bg-(--hover) hover:text-(--text)"
            title="Settings (Cmd/Ctrl+,)"
          >
            <MdiIcon path={mdiCogOutline} size="16px" />
          </button>
        </div>
      )}

      {overflowMenu && (
        <Menu
          x={overflowMenu.x}
          y={overflowMenu.y}
          width={240}
          onClose={() => setOverflowMenu(null)}
        >
          <MenuItem
            icon={mdiViewSplitVertical}
            label="Split right…"
            title="Split right (choose target host)"
            disabled={noActiveTab}
            onClick={(e) => {
              setOverflowMenu(null);
              openSplitMenu(e, "horizontal");
            }}
          />
          <MenuItem
            icon={mdiViewSplitHorizontal}
            label="Split down…"
            title="Split down (choose target host)"
            disabled={noActiveTab}
            onClick={(e) => {
              setOverflowMenu(null);
              openSplitMenu(e, "vertical");
            }}
          />
          <MenuItem
            icon={mdiBroadcast}
            label="Broadcast input to all panes"
            title="Broadcast input to all panes (MultiExec)"
            disabled={noActiveTab}
            onClick={() => {
              setOverflowMenu(null);
              toggleBroadcast(activeTabId!);
            }}
          />
          <MenuDivider />
          <MenuItem
            icon={mdiCogOutline}
            label="Settings…"
            title="Settings (Cmd/Ctrl+,)"
            onClick={() => setSettingsOpen(true)}
          />
        </Menu>
      )}

      {newTabMenu && (
        <Menu
          x={newTabMenu.x}
          y={newTabMenu.y}
          width={224}
          className="max-h-80 overflow-y-auto"
          onClose={() => setNewTabMenu(null)}
        >
          <MenuItem
            icon={mdiConsole}
            label="Local terminal"
            onClick={() => {
              setNewTabMenu(null);
              openLocalTab().catch(() => {});
            }}
          />
          <MenuItem
            icon={mdiSsh}
            label="SSH connection…"
            onClick={() => {
              setNewTabMenu(null);
              setNewConnPrefill(null);
              setNewConnOpen(true);
            }}
          />

          {savedSessions.length > 0 && (
            <p className="mt-1 border-t border-(--border) px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
              Saved
            </p>
          )}
          {savedSessions.map((s) => (
            <MenuItem
              key={s.id}
              icon={mdiSsh}
              label={<span className="truncate">{s.name}</span>}
              title={`${s.username}@${s.host}:${s.port}`}
              onClick={() => connectSavedAsTab(s)}
            />
          ))}

          {sshConfigHosts.length > 0 && (
            <p className="mt-1 border-t border-(--border) px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
              From ~/.ssh/config
            </p>
          )}
          {sshConfigHosts.map((h) => (
            <MenuItem
              key={h.alias}
              icon={mdiSsh}
              label={<span className="truncate">{h.alias}</span>}
              title={`${h.user ? `${h.user}@` : ""}${h.hostName}:${h.port ?? 22}`}
              onClick={() => connectSavedAsTab(sshConfigAsSaved(h))}
            />
          ))}
        </Menu>
      )}

      {newConnOpen && (
        <ConnectDialog
          prefill={newConnPrefill}
          onClose={() => setNewConnOpen(false)}
        />
      )}

      {splitMenu && activeTab && (
        <Menu
          x={splitMenu.x}
          y={splitMenu.y}
          width={224}
          className="max-h-80 overflow-y-auto"
          onClose={() => setSplitMenu(null)}
        >
          <p className="px-3 pt-1 pb-0.5 text-xs font-medium text-(--text-dim)">
            Split {splitMenu.direction === "horizontal" ? "right" : "down"} with
          </p>
          <MenuItem
            icon={mdiContentDuplicate}
            label="Duplicate current pane"
            onClick={() => {
              const { direction } = splitMenu;
              setSplitMenu(null);
              splitActivePane(direction).catch((e) => console.error(e));
            }}
          />
          <MenuItem
            icon={mdiConsole}
            label="Local terminal"
            onClick={() => {
              const { direction } = splitMenu;
              setSplitMenu(null);
              splitTabWithLocal(activeTabId!, direction).catch((e) =>
                console.error(e),
              );
            }}
          />

          {savedSessions.length > 0 && (
            <p className="px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
              Saved
            </p>
          )}
          {savedSessions.map((s) => (
            <MenuItem
              key={s.id}
              icon={mdiSsh}
              label={<span className="truncate">{s.name}</span>}
              title={`${s.username}@${s.host}:${s.port}`}
              onClick={() => splitToSession(s, splitMenu.direction)}
            />
          ))}

          {sshConfigHosts.length > 0 && (
            <p className="px-3 pt-2 pb-0.5 text-xs font-medium text-(--text-dim)">
              From ~/.ssh/config
            </p>
          )}
          {sshConfigHosts.map((h) => (
            <MenuItem
              key={h.alias}
              icon={mdiSsh}
              label={<span className="truncate">{h.alias}</span>}
              title={`${h.user ? `${h.user}@` : ""}${h.hostName}:${h.port ?? 22}`}
              onClick={() => splitToSession(sshConfigAsSaved(h), splitMenu.direction)}
            />
          ))}

          <MenuDivider />
          <MenuItem
            icon={mdiSsh}
            label="Other SSH connection…"
            onClick={() => {
              const { direction } = splitMenu;
              setSplitMenu(null);
              setSplitDialog({ prefill: null, direction });
            }}
          />
        </Menu>
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
