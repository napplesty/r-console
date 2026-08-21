import { useState } from "react";
import MdiIcon from "@mdi/react";
import {
  mdiBroadcast,
  mdiConsole,
  mdiContentDuplicate,
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

  const menuItemClass =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-(--text) hover:bg-white/5";

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-(--border) px-2 select-none">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`group flex cursor-pointer items-center gap-2 rounded px-3 py-1 text-sm ${
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
              className="max-w-40 truncate"
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
            <span className="text-xs text-(--text-dim)">
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
      <button
        onClick={() => openLocalTab().catch(() => {})}
        className="rounded px-2 py-1 text-(--text-dim) hover:bg-white/5 hover:text-(--text)"
        title="New local terminal"
      >
        +
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1">
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
      </div>
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
