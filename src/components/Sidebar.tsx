import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import MdiIcon from "@mdi/react";
import {
  mdiChevronLeft,
  mdiChevronRight,
  mdiPin,
  mdiPinOutline,
  mdiPlus,
} from "@mdi/js";
import { useAppStore } from "../state/store";
import { openLocalTab, sshConfigAsSaved, tryConnectSaved } from "../state/sessions";
import ConnectDialog from "./ConnectDialog";
import { Menu, MenuItem } from "./ui/Menu";
import type { SavedSession } from "../lib/types";

export default function Sidebar() {
  const savedSessions = useAppStore((s) => s.savedSessions);
  const sshConfigHosts = useAppStore((s) => s.sshConfigHosts);
  const loadSavedSessions = useAppStore((s) => s.loadSavedSessions);
  const loadSshConfigHosts = useAppStore((s) => s.loadSshConfigHosts);
  const removeSavedSession = useAppStore((s) => s.removeSavedSession);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const pinned = useAppStore((s) => s.sidebarPinned);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setSidebarPinned = useAppStore((s) => s.setSidebarPinned);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [prefill, setPrefill] = useState<SavedSession | null>(null);
  // "+ New Session" dropdown position (viewport coords), or null when closed.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Anchor the dropdown to the button that opened it: below it in the
  // expanded sidebar, beside it in the collapsed rail.
  const openMenu = (
    e: React.MouseEvent<HTMLButtonElement>,
    side = false,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos(
      side ? { x: rect.right + 4, y: rect.top } : { x: rect.left, y: rect.bottom + 4 },
    );
  };

  useEffect(() => {
    loadSavedSessions().catch(() => {});
    loadSshConfigHosts().catch(() => {});
  }, [loadSavedSessions, loadSshConfigHosts]);

  const openPrefilled = (s: SavedSession) => {
    setPrefill(s);
    setDialogOpen(true);
  };

  // Sessions whose credentials can be resolved silently (vault password or
  // unencrypted key) connect directly; anything else falls back to the
  // prefilled dialog so the user can complete the credentials.
  const connectSaved = async (s: SavedSession) => {
    if (!(await tryConnectSaved(s))) openPrefilled(s);
  };

  const newSessionMenu = menuPos && (
    <Menu x={menuPos.x} y={menuPos.y} width={176} onClose={() => setMenuPos(null)}>
      <MenuItem
        label="SSH connection…"
        onClick={() => {
          setMenuPos(null);
          setPrefill(null);
          setDialogOpen(true);
        }}
      />
      <MenuItem
        label="Local terminal"
        onClick={() => {
          setMenuPos(null);
          openLocalTab().catch(() => {});
        }}
      />
    </Menu>
  );

  return (
    <aside
      className={`flex ${collapsed ? "w-12" : "w-56"} shrink-0 flex-col border-r border-(--border) bg-(--panel) transition-[width] duration-200`}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-1 py-2">
          <button
            onClick={(e) => openMenu(e, true)}
            title="New Session"
            className="rounded p-1.5 text-(--text) hover:bg-(--hover-strong)"
          >
            <MdiIcon path={mdiPlus} size="18px" />
          </button>
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
            className="rounded p-1.5 text-(--text-dim) hover:bg-(--hover-strong)"
          >
            <MdiIcon path={mdiChevronRight} size="18px" />
          </button>
        </div>
      ) : (
        <>
          <div className="flex h-10 shrink-0 items-center justify-between gap-1 overflow-hidden border-b border-(--border) px-3">
            <span className="truncate text-sm font-semibold text-(--text)">
              Sessions
            </span>
            <div className="flex shrink-0 items-center">
              <button
                onClick={() => setSidebarPinned(!pinned)}
                title={pinned ? "Unpin sidebar" : "Pin sidebar"}
                className={`rounded p-1 hover:bg-(--hover-strong) ${
                  pinned ? "text-(--accent)" : "text-(--text-dim)"
                }`}
              >
                <MdiIcon path={pinned ? mdiPin : mdiPinOutline} size="16px" />
              </button>
              <button
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse sidebar"
                className="rounded p-1 text-(--text-dim) hover:bg-(--hover-strong)"
              >
                <MdiIcon path={mdiChevronLeft} size="16px" />
              </button>
            </div>
          </div>

          <div className="relative shrink-0 p-2">
            <button
              onClick={(e) => openMenu(e)}
              className="w-full rounded-md bg-(--accent) px-2 py-1.5 text-xs whitespace-nowrap text-white shadow-sm hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)]"
            >
              + New Session
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1">
            {savedSessions.length === 0 && sshConfigHosts.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-(--text-dim)">
                No saved sessions yet
              </p>
            )}

            {savedSessions.length > 0 && (
              <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-(--text-dim)">
                Saved
              </p>
            )}
            {savedSessions.map((s) => (
              <div
                key={s.id}
                onClick={() => connectSaved(s)}
                className="group flex cursor-pointer items-center justify-between rounded px-2 py-1.5 hover:bg-(--hover)"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-(--text)">{s.name}</div>
                  <div className="truncate text-xs text-(--text-dim)">
                    {s.username}@{s.host}:{s.port}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSavedSession(s.id).catch(() => {});
                    // Best-effort cleanup of the vault-stored password.
                    invoke("credential_delete", { sessionId: s.id }).catch(
                      () => {},
                    );
                  }}
                  className="rounded px-1 text-(--text-dim) opacity-0 group-hover:opacity-100 hover:bg-(--hover-strong) hover:text-(--text)"
                  title="Delete saved session"
                >
                  ×
                </button>
              </div>
            ))}

            {sshConfigHosts.length > 0 && (
              <p className="px-2 pt-3 pb-0.5 text-xs font-medium text-(--text-dim)">
                From ~/.ssh/config
              </p>
            )}
            {sshConfigHosts.map((h) => (
              <div
                key={h.alias}
                onClick={() => {
                  // Reuse the saved-session shape as dialog prefill; id "" means
                  // "not saved yet" and gets a fresh UUID when the user saves.
                  openPrefilled(sshConfigAsSaved(h));
                }}
                className="cursor-pointer rounded px-2 py-1.5 hover:bg-(--hover)"
                title={`${h.user ?? ""}@${h.hostName}:${h.port ?? 22}`}
              >
                <div className="truncate text-sm text-(--text)">{h.alias}</div>
                <div className="truncate text-xs text-(--text-dim)">
                  {h.user ? `${h.user}@` : ""}
                  {h.hostName}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {newSessionMenu}

      {dialogOpen && (
        <ConnectDialog prefill={prefill} onClose={() => setDialogOpen(false)} />
      )}
    </aside>
  );
}
