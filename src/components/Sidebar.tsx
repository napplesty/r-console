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
  const [menuOpen, setMenuOpen] = useState(false);

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

  const menuButtons = (
    <>
      <button
        onClick={() => {
          setMenuOpen(false);
          setPrefill(null);
          setDialogOpen(true);
        }}
        className="block w-full px-3 py-1.5 text-left text-xs text-(--text) hover:bg-white/5"
      >
        SSH connection…
      </button>
      <button
        onClick={() => {
          setMenuOpen(false);
          openLocalTab().catch(() => {});
        }}
        className="block w-full px-3 py-1.5 text-left text-xs text-(--text) hover:bg-white/5"
      >
        Local terminal
      </button>
    </>
  );

  return (
    <aside
      className={`flex ${collapsed ? "w-12" : "w-56"} shrink-0 flex-col border-r border-(--border) bg-(--panel) transition-[width] duration-200`}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-1 py-2">
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="New Session"
              className="rounded p-1.5 text-(--text) hover:bg-white/10"
            >
              <MdiIcon path={mdiPlus} size="18px" />
            </button>
            {menuOpen && (
              <>
                {/* Click-away layer closing the menu */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute top-0 left-full z-50 ml-1 w-44 rounded border border-(--border) bg-(--panel-alt) py-1 shadow-xl">
                  {menuButtons}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
            className="rounded p-1.5 text-(--text-dim) hover:bg-white/10"
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
                className={`rounded p-1 hover:bg-white/10 ${
                  pinned ? "text-(--accent)" : "text-(--text-dim)"
                }`}
              >
                <MdiIcon path={pinned ? mdiPin : mdiPinOutline} size="16px" />
              </button>
              <button
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse sidebar"
                className="rounded p-1 text-(--text-dim) hover:bg-white/10"
              >
                <MdiIcon path={mdiChevronLeft} size="16px" />
              </button>
            </div>
          </div>

          <div className="relative shrink-0 p-2">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="w-full rounded bg-(--accent) px-2 py-1.5 text-xs whitespace-nowrap text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)]"
            >
              + New Session
            </button>
            {menuOpen && (
              <>
                {/* Click-away layer closing the menu */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute inset-x-2 top-full z-50 mt-1 rounded border border-(--border) bg-(--panel-alt) py-1 shadow-xl">
                  {menuButtons}
                </div>
              </>
            )}
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
                className="group flex cursor-pointer items-center justify-between rounded px-2 py-1.5 hover:bg-white/5"
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
                  className="rounded px-1 text-(--text-dim) opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-(--text)"
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
                className="cursor-pointer rounded px-2 py-1.5 hover:bg-white/5"
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

      {dialogOpen && (
        <ConnectDialog prefill={prefill} onClose={() => setDialogOpen(false)} />
      )}
    </aside>
  );
}
