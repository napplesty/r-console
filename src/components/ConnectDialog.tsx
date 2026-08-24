import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SavedSession, SplitDirection, SshConnectConfig } from "../lib/types";
import { findSavedByEndpoint, openSshTab, splitTabWithSsh } from "../state/sessions";
import { useAppStore } from "../state/store";
import { withVaultRetry } from "../state/vault";

interface ConnectDialogProps {
  /** When set, the form is prefilled from this saved session. */
  prefill?: SavedSession | null;
  /**
   * When set, the connection is added as a pane of this tab (split mode)
   * instead of opening a new tab — used to build multi-host MultiExec layouts.
   */
  split?: { tabId: string; direction: SplitDirection } | null;
  onClose: () => void;
}

/** Modal form for creating an SSH connection (optionally saving it). */
export default function ConnectDialog({
  prefill,
  split,
  onClose,
}: ConnectDialogProps) {
  const loadSavedSessions = useAppStore((s) => s.loadSavedSessions);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authKind, setAuthKind] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [persistent, setPersistent] = useState(true);
  const [saveSession, setSaveSession] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name);
    setHost(prefill.host);
    setPort(String(prefill.port));
    setUsername(prefill.username);
    setAuthKind(prefill.authKind === "key" ? "key" : "password");
    setKeyPath(prefill.keyPath ?? "");
    setPersistent(prefill.persistent);
  }, [prefill]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      const config: SshConnectConfig = {
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        auth:
          authKind === "password"
            ? { kind: "password", password }
            : {
                kind: "key",
                keyPath: keyPath.trim(),
                passphrase: passphrase || undefined,
              },
        persistent,
      };
      const title = name.trim() || config.host;
      // The descriptor travels with the pane for workspace restore and
      // reconnects; with saveSession off it gets an empty id (no vault
      // credential attached). When saving, reuse the id of an existing entry
      // for the same endpoint instead of accumulating duplicates.
      const sessionId = saveSession
        ? prefill?.id ||
          findSavedByEndpoint(
            useAppStore.getState().savedSessions,
            config.host,
            config.port,
            config.username,
          )?.id ||
          crypto.randomUUID()
        : "";
      const savedRow: SavedSession = {
        id: sessionId,
        name: title,
        host: config.host,
        port: config.port,
        username: config.username,
        authKind,
        keyPath: authKind === "key" ? keyPath.trim() : null,
        persistent,
      };
      if (split) {
        await splitTabWithSsh(split.tabId, split.direction, config, title, savedRow);
      } else {
        await openSshTab(config, title, savedRow);
      }

      let saveNote: string | null = null;
      if (saveSession) {
        await invoke_save(savedRow);
        await loadSavedSessions();

        // Stash the password in the vault so the sidebar can one-click
        // connect later. Never fail the connection over this.
        if (authKind === "password") {
          try {
            const saved = await withVaultRetry(async () => {
              await invoke("credential_set", { sessionId, password });
              return true;
            });
            if (!saved) saveNote = "Password was not saved to the vault.";
          } catch (err) {
            console.warn("Failed to save password to vault:", err);
            saveNote = "Connected, but the password could not be saved.";
          }
        }
      }
      if (saveNote) {
        // Show the note briefly instead of failing the (successful) connect.
        setNote(saveNote);
        window.setTimeout(onClose, 2500);
      } else {
        onClose();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  };

  const inputCls =
    "w-full rounded border border-(--border) bg-(--panel) px-2 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="flex w-96 flex-col gap-3 rounded-lg border border-(--border) bg-(--panel-alt) p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-(--text)">
          {split
            ? "Add SSH Pane"
            : prefill
              ? "Connect"
              : "New SSH Connection"}
        </h2>

        <input
          className={inputCls}
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <input
            className={`${inputCls} min-w-0`}
            placeholder="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
          />
          <input
            className={`${inputCls} min-w-0`}
            placeholder="Port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <input
          className={inputCls}
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />

        <div className="flex gap-4 text-sm text-(--text)">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={authKind === "password"}
              onChange={() => setAuthKind("password")}
            />
            Password
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={authKind === "key"}
              onChange={() => setAuthKind("key")}
            />
            Private key
          </label>
        </div>

        {authKind === "password" ? (
          <input
            className={inputCls}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus={!!prefill}
          />
        ) : (
          <>
            <input
              className={inputCls}
              placeholder="Key path, e.g. ~/.ssh/id_ed25519"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              required
            />
            <input
              className={inputCls}
              type="password"
              placeholder="Passphrase (optional)"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </>
        )}

        <label className="flex items-center gap-2 text-sm text-(--text-dim)">
          <input
            type="checkbox"
            checked={persistent}
            onChange={(e) => setPersistent(e.target.checked)}
          />
          Persistent session (tmux — survives disconnects and restarts)
        </label>

        <label className="flex items-center gap-2 text-sm text-(--text-dim)">
          <input
            type="checkbox"
            checked={saveSession}
            onChange={(e) => setSaveSession(e.target.checked)}
          />
          Save to session list (passwords are stored in the encrypted vault)
        </label>

        {note && (
          <p className="rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-400">
            {note}
          </p>
        )}

        {error && (
          <p className="rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-(--text-dim) hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={connecting}
            className="rounded bg-(--accent) px-4 py-1.5 text-sm text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)] disabled:opacity-50"
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Local helper kept separate to keep the submit handler readable.
async function invoke_save(session: SavedSession): Promise<void> {
  await invoke("saved_sessions_save", { session });
}
