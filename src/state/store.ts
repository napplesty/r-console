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
import {
  DEFAULT_HIGHLIGHT_RULES,
  type HighlightRule,
} from "../lib/terminalHighlight";

const THEME_STORAGE_KEY = "r-console-theme";
const FONT_SIZE_STORAGE_KEY = "r-console-font-size";
const CURSOR_STYLE_STORAGE_KEY = "r-console-cursor-style";
const CURSOR_BLINK_STORAGE_KEY = "r-console-cursor-blink";
const IME_COMPAT_STORAGE_KEY = "r-console-ime-compat";
const FPS_OVERLAY_STORAGE_KEY = "r-console-fps-overlay";
const SCROLLBACK_STORAGE_KEY = "r-console-scrollback";
const FOLLOW_CWD_STORAGE_KEY = "r-console-follow-cwd";
const HIGHLIGHT_ENABLED_STORAGE_KEY = "r-console-highlight-enabled";
const HIGHLIGHT_RULES_STORAGE_KEY = "r-console-highlight-rules";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "r-console-sidebar-collapsed";
const SIDEBAR_PINNED_STORAGE_KEY = "r-console-sidebar-pinned";
const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_FONT_SIZE = 14;
const CURSOR_STYLES = ["block", "underline", "bar"] as const;

export type CursorStyle = (typeof CURSOR_STYLES)[number];

function readInitialFontSize(): number {
  const saved = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY));
  return Number.isFinite(saved) && saved >= 8 && saved <= 32 ? saved : DEFAULT_FONT_SIZE;
}

function readInitialCursorStyle(): CursorStyle {
  const saved = localStorage.getItem(CURSOR_STYLE_STORAGE_KEY);
  return (CURSOR_STYLES as readonly string[]).includes(saved ?? "")
    ? (saved as CursorStyle)
    : "block";
}

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

function isHighlightRule(r: unknown): r is HighlightRule {
  return (
    typeof r === "object" &&
    r !== null &&
    typeof (r as HighlightRule).pattern === "string"
  );
}

/** Persisted highlight rules; malformed entries fall back to the defaults. */
function readInitialHighlightRules(): HighlightRule[] {
  try {
    const saved = localStorage.getItem(HIGHLIGHT_RULES_STORAGE_KEY);
    if (!saved) return DEFAULT_HIGHLIGHT_RULES;
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return DEFAULT_HIGHLIGHT_RULES;
    const rules = parsed.filter(isHighlightRule);
    return rules.length > 0 ? rules : DEFAULT_HIGHLIGHT_RULES;
  } catch {
    return DEFAULT_HIGHLIGHT_RULES;
  }
}

/** Expose the active theme to CSS via a data attribute on <html>. */
function applyThemeAttribute(themeId: string) {
  document.documentElement.dataset.theme = themeId;
}

/**
 * Tear down a pane's backend resources: close the shell channel, and for
 * persistent (tmux) panes also kill the remote tmux session — closing a
 * pane is the user's explicit "I'm done with this session", so it should
 * not linger on the remote host. (Quitting the app does NOT go through
 * here; those sessions survive for workspace restore.)
 */
function closePaneBackend(pane: Pane): void {
  if (pane.sessionId) {
    invoke("session_close", { sessionId: pane.sessionId }).catch(() => {});
  }
  if (pane.tmuxSession && pane.connKey) {
    invoke("tmux_control_send", {
      connKey: pane.connKey,
      line: `kill-session -t ${pane.tmuxSession}`,
    }).catch(() => {});
  }
}

interface AppState {  tabs: Tab[];
  activeTabId: string | null;
  savedSessions: SavedSession[];
  sshConfigHosts: SshConfigHost[];
  themeId: string;
  /** Terminal font size in px; applied to open terminals live. */
  fontSize: number;
  /** Terminal cursor shape. */
  cursorStyle: CursorStyle;
  /** Terminal cursor blink. */
  cursorBlink: boolean;
  /**
   * IME compatibility (xterm screenReaderMode): keeps the input textarea
   * visible with a real caret, which improves IME composition on Linux
   * webviews. Off by default — it mirrors terminal text for assistive tech
   * and costs some render work.
   */
  imeCompat: boolean;
  /** Show the FPS overlay (performance diagnostics). */
  fpsOverlay: boolean;
  /** Terminal scrollback lines; applies to terminals opened afterwards. */
  scrollback: number;
  /** Whether OSC 7 cwd reports update the UI (SFTP panel follows terminal). */
  followCwd: boolean;
  /** Whether rule-based keyword highlighting decorates terminal output. */
  highlightEnabled: boolean;
  /** Keyword highlight rules, in priority order (first rule wins). */
  highlightRules: HighlightRule[];
  /** Wall-clock timestamp of the next auto-reconnect attempt, per pane. */
  nextRetryAtByPane: Record<string, number>;
  /** Whether the credential vault is currently unlocked. */
  vaultUnlocked: boolean;
  /** Controls visibility of the master-password vault dialog. */
  vaultDialogOpen: boolean;
  /** Controls visibility of the command palette (Cmd/Ctrl+K). */
  paletteOpen: boolean;
  /** Controls visibility of the Git side panel (Cmd/Ctrl+G). */
  gitPanelOpen: boolean;
  /** Controls visibility of the settings dialog (Cmd/Ctrl+,). */
  settingsOpen: boolean;
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
  setFontSize: (size: number) => void;
  setCursorStyle: (style: CursorStyle) => void;
  setCursorBlink: (blink: boolean) => void;
  setImeCompat: (on: boolean) => void;
  setFpsOverlay: (on: boolean) => void;
  setScrollback: (lines: number) => void;
  setFollowCwd: (follow: boolean) => void;
  setHighlightEnabled: (enabled: boolean) => void;
  setHighlightRules: (rules: HighlightRule[]) => void;
  setPaneNextRetryAt: (paneId: string, at: number | null) => void;
  setVaultUnlocked: (unlocked: boolean) => void;
  setVaultDialogOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setGitPanelOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
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
  fontSize: readInitialFontSize(),
  cursorStyle: readInitialCursorStyle(),
  cursorBlink: readStoredBool(CURSOR_BLINK_STORAGE_KEY, true),
  imeCompat: readStoredBool(IME_COMPAT_STORAGE_KEY, false),
  fpsOverlay: readStoredBool(FPS_OVERLAY_STORAGE_KEY, false),
  scrollback: readInitialScrollback(),
  followCwd: readStoredBool(FOLLOW_CWD_STORAGE_KEY, true),
  highlightEnabled: readStoredBool(HIGHLIGHT_ENABLED_STORAGE_KEY, true),
  highlightRules: readInitialHighlightRules(),
  nextRetryAtByPane: {},
  vaultUnlocked: false,
  vaultDialogOpen: false,
  paletteOpen: false,
  gitPanelOpen: false,
  settingsOpen: false,
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
      for (const pane of tab.panes) closePaneBackend(pane);
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
    const rest = tab.panes.filter((p) => p.id !== paneId);
    if (rest.length === 0) {
      // closeTab tears down every pane's backend, including this one.
      closeTab(tabId);
      return;
    }
    closePaneBackend(pane);
    set((s) => {
      const cwdBySession = { ...s.cwdBySession };
      delete cwdBySession[pane.sessionId];
      return {
        cwdBySession,
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
      };
    });
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

  setFontSize: (size) => {
    const value = Math.min(32, Math.max(8, Math.floor(size)));
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(value));
    set({ fontSize: value });
  },

  setCursorStyle: (style) => {
    localStorage.setItem(CURSOR_STYLE_STORAGE_KEY, style);
    set({ cursorStyle: style });
  },

  setCursorBlink: (blink) => {
    localStorage.setItem(CURSOR_BLINK_STORAGE_KEY, String(blink));
    set({ cursorBlink: blink });
  },

  setImeCompat: (on) => {
    localStorage.setItem(IME_COMPAT_STORAGE_KEY, String(on));
    set({ imeCompat: on });
  },

  setFpsOverlay: (on) => {
    localStorage.setItem(FPS_OVERLAY_STORAGE_KEY, String(on));
    set({ fpsOverlay: on });
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

  setHighlightEnabled: (enabled) => {
    localStorage.setItem(HIGHLIGHT_ENABLED_STORAGE_KEY, String(enabled));
    set({ highlightEnabled: enabled });
  },

  setHighlightRules: (rules) => {
    const valid = rules.filter(isHighlightRule);
    localStorage.setItem(HIGHLIGHT_RULES_STORAGE_KEY, JSON.stringify(valid));
    set({ highlightRules: valid });
  },

  setPaneNextRetryAt: (paneId, at) =>
    set((s) => {
      const nextRetryAtByPane = { ...s.nextRetryAtByPane };
      if (at === null) delete nextRetryAtByPane[paneId];
      else nextRetryAtByPane[paneId] = at;
      return { nextRetryAtByPane };
    }),

  setVaultUnlocked: (unlocked) => set({ vaultUnlocked: unlocked }),

  setVaultDialogOpen: (open) => set({ vaultDialogOpen: open }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  setGitPanelOpen: (open) => set({ gitPanelOpen: open }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

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
