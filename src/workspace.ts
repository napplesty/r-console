/**
 * Workspace persistence: snapshot the tab/pane layout (debounced, on every
 * change) and restore it on app start. Local panes respawn immediately;
 * SSH panes come back in "reconnecting" state and auto-reattach — with
 * persistent (tmux) sessions this restores the full remote context.
 *
 * Secrets are never persisted: SSH panes store a SavedSession-shaped
 * descriptor; passwords are re-resolved from the vault during reconnect.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { attemptReconnect, spawnLocalPane } from "./sessions";
import type { Pane, SavedSession, SplitDirection, TabKind } from "./types";

interface PersistedPane {
  kind: TabKind;
  title: string;
  saved?: SavedSession | null;
  tmuxSession?: string;
}

interface PersistedTab {
  title: string;
  direction: SplitDirection;
  broadcast: boolean;
  activePaneIndex: number;
  panes: PersistedPane[];
}

interface WorkspaceSnapshot {
  tabs: PersistedTab[];
  activeTabIndex: number;
}

/** A restorable descriptor for panes that have no saved-session row. */
function pseudoSaved(p: Pane): SavedSession | null {
  const c = p.connectConfig;
  if (!c) return null;
  return {
    id: "",
    name: p.title,
    host: c.host,
    port: c.port,
    username: c.username,
    authKind: c.auth.kind,
    keyPath: c.auth.kind === "key" ? c.auth.keyPath : null,
    persistent: c.persistent,
  };
}

function toPersistedPane(p: Pane): PersistedPane | null {
  if (p.kind === "local") return { kind: "local", title: p.title };
  const saved = p.saved ?? pseudoSaved(p);
  if (!saved) return null;
  return { kind: "ssh", title: p.title, saved, tmuxSession: p.tmuxSession };
}

function buildSnapshot(): WorkspaceSnapshot {
  const { tabs, activeTabId } = useAppStore.getState();
  const persistedTabs: PersistedTab[] = [];
  let activeTabIndex = 0;
  for (const t of tabs) {
    const panes = t.panes
      .map(toPersistedPane)
      .filter((p): p is PersistedPane => p !== null);
    if (panes.length === 0) continue;
    if (t.id === activeTabId) activeTabIndex = persistedTabs.length;
    persistedTabs.push({
      title: t.title,
      direction: t.direction,
      broadcast: t.broadcast,
      activePaneIndex: Math.max(
        0,
        t.panes.findIndex((p) => p.id === t.activePaneId),
      ),
      panes,
    });
  }
  return { tabs: persistedTabs, activeTabIndex };
}

// Persist (debounced) whenever the tab layout changes. Registered at module
// load; the snapshot is a plain JSON string, the schema lives here only.
let persistTimer: number | undefined;
useAppStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs && state.activeTabId === prev.activeTabId) return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    invoke("workspace_save", {
      snapshot: JSON.stringify(buildSnapshot()),
    }).catch((e) => console.warn("workspace_save failed:", e));
  }, 1000);
});

/** Restore the workspace snapshot on app start. */
export async function restoreWorkspace(): Promise<void> {
  const raw = await invoke<string | null>("workspace_load").catch(() => null);
  if (!raw) return;
  let snap: WorkspaceSnapshot;
  try {
    snap = JSON.parse(raw);
  } catch {
    console.warn("Ignoring unparseable workspace snapshot");
    return;
  }
  if (!Array.isArray(snap.tabs) || snap.tabs.length === 0) return;

  const restoredTabIds: string[] = [];
  for (const t of snap.tabs) {
    const panes: Pane[] = [];
    for (const p of t.panes) {
      if (p.kind === "local") {
        try {
          panes.push(await spawnLocalPane(p.title));
        } catch (e) {
          console.warn("Failed to restore local pane:", e);
        }
      } else if (p.saved) {
        // SSH panes come back sessionless; auto-reconnect fills sessionId.
        panes.push({
          id: crypto.randomUUID(),
          sessionId: "",
          kind: "ssh",
          title: p.title,
          saved: p.saved,
          tmuxSession: p.tmuxSession,
          status: "reconnecting",
        });
      }
    }
    if (panes.length === 0) continue;
    const tabId = crypto.randomUUID();
    const activeIndex = Math.min(t.activePaneIndex, panes.length - 1);
    useAppStore.getState().addTab({
      id: tabId,
      title: t.title,
      panes,
      direction: t.direction,
      broadcast: t.broadcast,
      activePaneId: panes[activeIndex].id,
    });
    restoredTabIds.push(tabId);

    // Kick off reconnects for this tab's SSH panes.
    for (const pane of panes) {
      if (pane.kind === "ssh") void attemptReconnect(tabId, pane.id);
    }
  }

  const { tabs, setActiveTab } = useAppStore.getState();
  const target = tabs[Math.min(snap.activeTabIndex, tabs.length - 1)];
  if (target) setActiveTab(target.id);
}
