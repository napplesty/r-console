import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { activePane, useAppStore } from "./state/store";
import { openLocalTab, scheduleReconnect, splitActivePane } from "./state/sessions";
import { restoreWorkspace } from "./state/workspace";
import { checkForUpdates } from "./lib/updater";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import TerminalView from "./components/Terminal";
import SftpPanel from "./components/SftpPanel";
import StatusBar from "./components/StatusBar";
import HostKeyDialog from "./components/HostKeyDialog";
import VaultDialog from "./components/VaultDialog";
import CommandPalette from "./components/CommandPalette";
import Welcome from "./components/Welcome";

interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}

function App() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const closePane = useAppStore((s) => s.closePane);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const cwdBySession = useAppStore((s) => s.cwdBySession);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const pane = activeTab ? activePane(activeTab) : undefined;

  // On start, prompt for the master password when the vault exists but is
  // locked. A never-initialized vault stays silent until first credential use.
  useEffect(() => {
    invoke<VaultStatus>("vault_status")
      .then((st) => {
        const { setVaultUnlocked, setVaultDialogOpen } = useAppStore.getState();
        setVaultUnlocked(st.unlocked);
        if (st.initialized && !st.unlocked) setVaultDialogOpen(true);
      })
      .catch(() => {});
  }, []);

  // Restore the previous workspace (tab layout + auto-reconnect) on start.
  useEffect(() => {
    restoreWorkspace().catch((e) => console.warn("workspace restore failed:", e));
  }, []);

  // Silent update check, delayed so it doesn't compete with startup work.
  useEffect(() => {
    const t = window.setTimeout(() => void checkForUpdates(true), 5000);
    return () => window.clearTimeout(t);
  }, []);

  // Global app shortcuts, registered in the capture phase so they also work
  // while an xterm terminal has focus. Editable fields keep their native
  // behavior (except Cmd/Ctrl+K, which always toggles the palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        const s = useAppStore.getState();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }

      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          (target.tagName === "TEXTAREA" &&
            !target.classList.contains("xterm-helper-textarea")));
      if (inEditable) return;

      const s = useAppStore.getState();
      if (key === "t") {
        e.preventDefault();
        openLocalTab().catch(() => {});
      } else if (key === "w" && s.activeTabId) {
        e.preventDefault();
        s.closeTab(s.activeTabId);
      } else if (key === "d" && s.activeTabId) {
        e.preventDefault();
        splitActivePane(e.shiftKey ? "vertical" : "horizontal").catch(() => {});
      } else if (key === "enter" && e.shiftKey && s.activeTabId) {
        e.preventDefault();
        s.toggleBroadcast(s.activeTabId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-(--bg) text-(--text)">
      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <main className="min-h-0 flex-1 p-1">
            {tabs.length === 0 && <Welcome />}
            {tabs.map((tab) => {
              // Broadcast mode outlines every pane with a thin accent ring;
              // the focused pane keeps full opacity, the rest stay subtle.
              const broadcastOn = tab.broadcast && tab.panes.length > 1;
              return (
              <div
                key={tab.id}
                className={
                  tab.id === activeTabId
                    ? `pane-fade flex h-full w-full ${
                        tab.direction === "horizontal" ? "flex-row" : "flex-col"
                      }`
                    : "hidden"
                }
              >
                {tab.panes.map((p, i) => {
                  const isActivePane = p.id === tab.activePaneId;
                  const ringOpacity = isActivePane ? 100 : broadcastOn ? 45 : 0;
                  return (
                  <div
                    key={p.id}
                    onClick={() => setActivePane(tab.id, p.id)}
                    className={`relative min-h-0 min-w-0 flex-1 transition-shadow duration-150 ${
                      i > 0
                        ? tab.direction === "horizontal"
                          ? "border-l border-(--border)"
                          : "border-t border-(--border)"
                        : ""
                    }`}
                    style={{
                      boxShadow:
                        ringOpacity > 0
                          ? `inset 0 0 0 1px color-mix(in srgb, var(--accent) ${ringOpacity}%, transparent)`
                          : undefined,
                    }}
                  >
                    <TerminalView
                      tabId={tab.id}
                      pane={p}
                      active={
                        tab.id === activeTabId && p.id === tab.activePaneId
                      }
                      onExit={() => closePane(tab.id, p.id)}
                      onDisconnect={() => scheduleReconnect(tab.id, p.id)}
                    />
                  </div>
                  );
                })}
              </div>
              );
            })}
          </main>
        </div>

        {pane?.kind === "ssh" && pane.connKey && (
          <SftpPanel
            connKey={pane.connKey}
            terminalCwd={cwdBySession[pane.sessionId]}
          />
        )}
      </div>

      <StatusBar />

      <HostKeyDialog />
      <VaultDialog />
      <CommandPalette />
    </div>
  );
}

export default App;
