import { invoke } from "@tauri-apps/api/core";
import { activePane, useAppStore } from "./store";
import { withVaultRetry } from "./vault";
import type {
  Pane,
  SavedSession,
  SplitDirection,
  SshConfigHost,
  SshConnectConfig,
  SshSessionInfo,
} from "./types";

/** Short unique tmux session name (sanitized server-side before use). */
function genTmuxSessionName(): string {
  return `rc-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Spawn an SSH shell and return it as a pane. Persistent sessions get a
 * tmux session name generated here (once per pane); the name travels with
 * the pane's connectConfig so reconnects reattach to the same remote
 * session.
 */
async function spawnSshPane(
  config: SshConnectConfig,
  title: string,
  saved?: SavedSession | null,
): Promise<Pane> {
  if (config.persistent && !config.tmuxSession) {
    config = { ...config, tmuxSession: genTmuxSessionName() };
  }
  const info = await invoke<SshSessionInfo>("session_spawn_ssh", {
    config,
    cols: 80,
    rows: 24,
  });
  return {
    id: crypto.randomUUID(),
    sessionId: info.sessionId,
    kind: "ssh",
    connKey: info.connKey,
    title,
    connectConfig: config,
    saved: saved ?? null,
    tmuxSession: config.tmuxSession,
  };
}

/** Spawn a local shell and return it as a pane. */
export async function spawnLocalPane(title: string): Promise<Pane> {
  const sessionId = await invoke<string>("session_spawn_local", {
    cols: 80,
    rows: 24,
  });
  return {
    id: crypto.randomUUID(),
    sessionId,
    kind: "local",
    title,
  };
}

/** Spawn a local shell session and open it in a new single-pane tab. */
export async function openLocalTab(): Promise<void> {
  const pane = await spawnLocalPane("Terminal");
  useAppStore.getState().addTab({
    id: crypto.randomUUID(),
    title: pane.title,
    panes: [pane],
    direction: "horizontal",
    broadcast: false,
    activePaneId: pane.id,
  });
}

/**
 * Establish (or reuse) an SSH connection and open a shell in a new
 * single-pane tab. Throws with a user-readable message on failure; the
 * caller displays it.
 */
export async function openSshTab(
  config: SshConnectConfig,
  title: string,
  saved?: SavedSession | null,
): Promise<void> {
  const pane = await spawnSshPane(config, title, saved);
  useAppStore.getState().addTab({
    id: crypto.randomUUID(),
    title: pane.title,
    panes: [pane],
    direction: "horizontal",
    broadcast: false,
    activePaneId: pane.id,
  });
}

/** Append a local-shell pane to an existing tab (used by the split menu). */
export async function splitTabWithLocal(
  tabId: string,
  direction: SplitDirection,
): Promise<void> {
  const pane = await spawnLocalPane("Terminal");
  useAppStore.getState().splitPane(tabId, direction, pane);
}

/**
 * Append an SSH pane to an existing tab. The target host may differ from the
 * tab's other panes — this is what enables MultiExec across machines.
 */
export async function splitTabWithSsh(
  tabId: string,
  direction: SplitDirection,
  config: SshConnectConfig,
  title: string,
  saved?: SavedSession | null,
): Promise<void> {
  const pane = await spawnSshPane(config, title, saved);
  useAppStore.getState().splitPane(tabId, direction, pane);
}

/**
 * Build a connect config for a saved session without user interaction:
 * key auth uses the stored key path, password auth looks the password up in
 * the vault (unlocking it if needed). Returns null when credentials are
 * missing and the caller should fall back to the connect dialog.
 */
export async function resolveSavedSessionConfig(
  s: SavedSession,
): Promise<SshConnectConfig | null> {
  if (s.authKind === "key") {
    if (!s.keyPath) return null;
    return {
      host: s.host,
      port: s.port,
      username: s.username,
      auth: { kind: "key", keyPath: s.keyPath },
      persistent: s.persistent,
    };
  }
  let password: string | null = null;
  try {
    password = await withVaultRetry(() =>
      invoke<string | null>("credential_get", { sessionId: s.id }),
    );
  } catch (err) {
    console.error("credential_get failed:", err);
  }
  if (!password) return null;
  return {
    host: s.host,
    port: s.port,
    username: s.username,
    auth: { kind: "password", password },
    persistent: s.persistent,
  };
}

/**
 * Adapt an ~/.ssh/config host entry into the saved-session shape so it can
 * flow through the same connect paths. The empty id marks it as "not saved
 * yet": no vault credential is attached.
 */
export function sshConfigAsSaved(h: SshConfigHost): SavedSession {
  return {
    id: "",
    name: h.alias,
    host: h.hostName,
    port: h.port ?? 22,
    username: h.user ?? "",
    authKind: h.identityFile ? "key" : "password",
    keyPath: h.identityFile ?? null,
    persistent: true,
  };
}

/**
 * One-click connect for a saved (or ssh-config-derived) session: resolve
 * credentials silently and open a new tab. Returns false when credentials
 * are missing or the connect failed — the caller should then fall back to
 * the prefilled connect dialog.
 */
export async function tryConnectSaved(s: SavedSession): Promise<boolean> {
  const config = await resolveSavedSessionConfig(s);
  if (!config) return false;
  try {
    await openSshTab(config, s.name, s);
    return true;
  } catch (err) {
    console.error("SSH connect failed:", err);
    return false;
  }
}

/**
 * Split the active tab's active pane with a duplicate of itself: spawn
 * another shell of the same kind (SSH panes re-authenticate with their
 * in-memory connectConfig, so no credential prompt). No-op without an
 * active tab.
 */
export async function splitActivePane(direction: SplitDirection): Promise<void> {
  const { tabs, activeTabId, splitPane } = useAppStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  const pane = activePane(tab);

  const newPane = pane.connectConfig
    ? // A split gets its own tmux session: sharing the source pane's
      // tmuxSession would attach both panes to the same remote session.
      await spawnSshPane(
        { ...pane.connectConfig, tmuxSession: undefined },
        pane.title,
        pane.saved,
      )
    : await spawnLocalPane(pane.title);
  splitPane(tab.id, direction, newPane);
}

// ---------------------------------------------------------------------------
// Auto-reconnect (keepalive): when the backend reports an unexpected
// transport loss (`session-disconnect-*`), the pane stays open with an
// overlay and the session is re-established with exponential backoff.
// Persistent (tmux) panes reattach to their previous remote session.
// ---------------------------------------------------------------------------

interface ReconnectEntry {
  attempts: number;
  timer?: number;
}

const reconnects = new Map<string, ReconnectEntry>();
const MAX_BACKOFF_MS = 15_000;

function findPane(tabId: string, paneId: string): Pane | undefined {
  return useAppStore
    .getState()
    .tabs.find((t) => t.id === tabId)
    ?.panes.find((p) => p.id === paneId);
}

/** Schedule (or re-schedule after a failed attempt) a reconnect. */
export function scheduleReconnect(tabId: string, paneId: string): void {
  const pane = findPane(tabId, paneId);
  if (!pane || pane.status === "dead") return;
  const entry = reconnects.get(paneId) ?? { attempts: 0 };
  entry.attempts += 1;
  reconnects.set(paneId, entry);
  useAppStore.getState().updatePane(tabId, paneId, { status: "reconnecting" });
  const delay = Math.min(1000 * 2 ** (entry.attempts - 1), MAX_BACKOFF_MS);
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => void attemptReconnect(tabId, paneId), delay);
}

/** Single reconnect attempt; reschedules itself on failure. */
export async function attemptReconnect(
  tabId: string,
  paneId: string,
): Promise<boolean> {
  const pane = findPane(tabId, paneId);
  if (!pane || pane.status !== "reconnecting") return false;

  // Prefer the in-memory config (has the password); after an app restart
  // only the saved descriptor exists, so resolve via the vault.
  let config = pane.connectConfig;
  if (!config && pane.saved) {
    config = (await resolveSavedSessionConfig(pane.saved)) ?? undefined;
  }
  if (config && pane.tmuxSession && !config.tmuxSession) {
    config = { ...config, tmuxSession: pane.tmuxSession };
  }
  if (!config) {
    reconnects.delete(paneId);
    useAppStore.getState().updatePane(tabId, paneId, { status: "dead" });
    return false;
  }

  try {
    const info = await invoke<SshSessionInfo>("session_spawn_ssh", {
      config,
      cols: 80,
      rows: 24,
    });
    reconnects.delete(paneId);
    useAppStore.getState().updatePane(tabId, paneId, {
      sessionId: info.sessionId,
      connKey: info.connKey,
      connectConfig: config,
      status: "live",
    });
    return true;
  } catch (err) {
    console.warn("Reconnect failed, will retry:", err);
    scheduleReconnect(tabId, paneId);
    return false;
  }
}

/** Stop reconnecting and leave the pane in the manual-retry "dead" state. */
export function cancelReconnect(tabId: string, paneId: string): void {
  const entry = reconnects.get(paneId);
  if (entry?.timer) window.clearTimeout(entry.timer);
  reconnects.delete(paneId);
  useAppStore.getState().updatePane(tabId, paneId, { status: "dead" });
}

/** Manual retry from the "dead" overlay. Returns false when no credentials
 *  can be resolved — the caller should offer the connect dialog. */
export async function retryReconnect(
  tabId: string,
  paneId: string,
): Promise<boolean> {
  const entry = reconnects.get(paneId);
  if (entry?.timer) window.clearTimeout(entry.timer);
  reconnects.delete(paneId);
  useAppStore.getState().updatePane(tabId, paneId, { status: "reconnecting" });
  return attemptReconnect(tabId, paneId);
}
