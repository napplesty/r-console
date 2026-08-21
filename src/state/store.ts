import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  Pane,
  SavedSession,
  SplitDirection,
  SshConfigHost,
  Tab,
} from "../lib/types";
import { DEFAULT_THEME_ID, THEMES } from "../lib/themes";

const THEME_STORAGE_KEY = "r-console-theme";
const SCROLLBACK_STORAGE_KEY = "r-console-scrollback";
const FOLLOW_CWD_STORAGE_KEY = "r-console-follow-cwd";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "r-console-sidebar-collapsed";
const SIDEBAR_PINNED_STORAGE_KEY = "r-console-sidebar-pinned";
const DEFAULT_SCROLLBACK = 5000;

function readInitialThemeId(): string {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return saved && saved in THEMES ? saved : DEFAULT_THEME_ID;
}

function readInitialScrollback(): number {
  const saved = Number(localStorage.getItem(SCROLLBACK_STORAGE_KEY));
  return Number.isFinite(saved) && saved >= 100 ? saved : DEFAULT_SCROLLBACK;
}

function readStoredBool(key: string, fallback: boolean): boolean {
  const saved = localStorage.getItem(key);
  return saved === null ? fallback : saved === "true";
}

/** Expose the active theme to CSS via a data attribute on <html>. */
function applyThemeAttribute(themeId: string) {
  document.documentElement.dataset.theme = themeId;
}

interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  savedSessions: SavedSession[];
  sshConfigHosts: SshConfigHost[];
  themeId: string;
  /** Terminal scrollback lines; applies to terminals opened afterwards. */
  scrollback: number;
  /** Whether OSC 7 cwd reports update the UI (SFTP panel follows terminal). */
  followCwd: boolean;
  /** Whether the credential vault is currently unlocked. */
  vaultUnlocked: boolean;
  /** Controls visibility of the master-password vault dialog. */
  vaultDialogOpen: boolean;
  /** Controls visibility of the command palette (Cmd/Ctrl+K). */
  paletteOpen: boolean;
  /** Narrow-rail sidebar mode (persisted). */
  sidebarCollapsed: boolean;
  /** When unpinned, the sidebar auto-collapses after a tab is launched. */
  sidebarPinned: boolean;
  /** Latest shell-reported working directory per backend session (OSC 7). */
  cwdBySession: Record<string, string>;
  addTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  closePane: (tabId: string, paneId: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  /** Patch fields of one pane (sessionId on reconnect, status, ...). */
  updatePane: (tabId: string, paneId: string, patch: Partial<Pane>) => void;
  splitPane: (tabId: string, direction: SplitDirection, pane: Pane) => void;
  toggleBroadcast: (tabId: string) => void;
  sendInput: (tabId: string, paneId: string, data: string) => void;
  loadSavedSessions: () => Promise<void>;
  removeSavedSession: (id: string) => Promise<void>;
  loadSshConfigHosts: () => Promise<void>;
  setThemeId: (id: string) => void;
  setScrollback: (lines: number) => void;
  setFollowCwd: (follow: boolean) => void;
  setVaultUnlocked: (unlocked: boolean) => void;
  setVaultDialogOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarPinned: (pinned: boolean) => void;
  setSessionCwd: (sessionId: string, cwd: string) => void;
}

const initialThemeId = readInitialThemeId();
applyThemeAttribute(initialThemeId);

/** The focused pane of a tab (falls back to the first pane). */
export function activePane(tab: Tab): Pane {
  return tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0];
}

export const useAppStore = create<AppState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  savedSessions: [],
  sshConfigHosts: [],
  themeId: initialThemeId,
  scrollback: readInitialScrollback(),
  followCwd: readStoredBool(FOLLOW_CWD_STORAGE_KEY, true),
  vaultUnlocked: false,
  vaultDialogOpen: false,
  paletteOpen: false,
  sidebarCollapsed: readStoredBool(SIDEBAR_COLLAPSED_STORAGE_KEY, false),
  sidebarPinned: readStoredBool(SIDEBAR_PINNED_STORAGE_KEY, true),
  cwdBySession: {},

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      // The sidebar is mainly a launcher: auto-collapse when unpinned.
      sidebarCollapsed: s.sidebarPinned ? s.sidebarCollapsed : true,
    })),

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === id);
    if (tab) {
      for (const pane of tab.panes) {
        invoke("session_close", { sessionId: pane.sessionId }).catch(() => {});
      }
    }
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    set((s) => {
      const cwdBySession = { ...s.cwdBySession };
      if (tab) for (const pane of tab.panes) delete cwdBySession[pane.sessionId];
      return {
        tabs: next,
        cwdBySession,
        activeTabId:
          activeTabId === id
            ? (next[Math.min(idx, next.length - 1)]?.id ?? null)
            : activeTabId,
      };
    });
  },

  closePane: (tabId, paneId) => {
    const { tabs, closeTab } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = tab.panes.find((p) => p.id === paneId);
    if (!pane) return;
    invoke("session_close", { sessionId: pane.sessionId }).catch(() => {});
    set((s) => {
      const cwdBySession = { ...s.cwdBySession };
      delete cwdBySession[pane.sessionId];
      return { cwdBySession };
    });
    const rest = tab.panes.filter((p) => p.id !== paneId);
    if (rest.length === 0) {
      closeTab(tabId);
      return;
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: rest,
              activePaneId:
                t.activePaneId === paneId ? rest[0].id : t.activePaneId,
            }
          : t,
      ),
    }));
  },

  setActivePane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.panes.some((p) => p.id === paneId)
          ? { ...t, activePaneId: paneId }
          : t,
      ),
    })),

  updatePane: (tabId, paneId, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: t.panes.map((p) =>
                p.id === paneId ? { ...p, ...patch } : p,
              ),
            }
          : t,
      ),
    })),

  splitPane: (tabId, direction, pane) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              direction,
              panes: [...t.panes, pane],
              activePaneId: pane.id,
            }
          : t,
      ),
    })),

  toggleBroadcast: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, broadcast: !t.broadcast } : t,
      ),
    })),

  sendInput: (tabId, paneId, data) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const targets = tab.broadcast
      ? tab.panes
      : tab.panes.filter((p) => p.id === paneId);
    for (const pane of targets) {
      invoke("session_write", { sessionId: pane.sessionId, data }).catch(
        () => {},
      );
    }
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  setThemeId: (id) => {
    if (!(id in THEMES)) return;
    localStorage.setItem(THEME_STORAGE_KEY, id);
    applyThemeAttribute(id);
    set({ themeId: id });
  },

  setScrollback: (lines) => {
    const value = Math.max(100, Math.floor(lines));
    localStorage.setItem(SCROLLBACK_STORAGE_KEY, String(value));
    set({ scrollback: value });
  },

  setFollowCwd: (follow) => {
    localStorage.setItem(FOLLOW_CWD_STORAGE_KEY, String(follow));
    set({ followCwd: follow });
  },

  setVaultUnlocked: (unlocked) => set({ vaultUnlocked: unlocked }),

  setVaultDialogOpen: (open) => set({ vaultDialogOpen: open }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  setSidebarCollapsed: (collapsed) => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
    set({ sidebarCollapsed: collapsed });
  },

  setSidebarPinned: (pinned) => {
    localStorage.setItem(SIDEBAR_PINNED_STORAGE_KEY, String(pinned));
    set({ sidebarPinned: pinned });
  },

  setSessionCwd: (sessionId, cwd) =>
    set((s) => ({ cwdBySession: { ...s.cwdBySession, [sessionId]: cwd } })),

  loadSavedSessions: async () => {
    const list = await invoke<SavedSession[]>("saved_sessions_list");
    set({ savedSessions: list });
  },

  removeSavedSession: async (id) => {
    await invoke("saved_sessions_delete", { id });
    set((s) => ({
      savedSessions: s.savedSessions.filter((x) => x.id !== id),
    }));
  },

  loadSshConfigHosts: async () => {
    const list = await invoke<SshConfigHost[]>("ssh_config_hosts");
    set({ sshConfigHosts: list });
  },
}));
