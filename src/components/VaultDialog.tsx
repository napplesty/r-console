import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { settleVaultUnlock } from "../vault";

interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}

/**
 * Master-password dialog. Shown at startup when the vault exists but is
 * locked, and lazily whenever a credential operation hits "Vault is locked".
 * On first ever use (vault not initialized) it creates the vault instead.
 */
export default function VaultDialog() {
  const open = useAppStore((s) => s.vaultDialogOpen);
  const setVaultUnlocked = useAppStore((s) => s.setVaultUnlocked);

  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Refresh the vault state every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setConfirm("");
    setError(null);
    invoke<VaultStatus>("vault_status")
      .then((st) => setInitialized(st.initialized))
      .catch(() => setInitialized(null));
  }, [open]);

  if (!open) return null;

  const creating = initialized === false;
  const close = (unlocked: boolean) => settleVaultUnlock(unlocked);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (creating && password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      // On first use this also creates the vault with this password.
      await invoke("vault_unlock", { masterPassword: password });
      setVaultUnlocked(true);
      close(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded border border-(--border) bg-(--panel) px-2 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={submit}
        className="flex w-80 flex-col gap-3 rounded-lg border border-(--border) bg-(--panel-alt) p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-(--text)">
          {creating ? "Create a master password" : "Unlock vault"}
        </h2>
        <p className="text-xs text-(--text-dim)">
          {creating
            ? "This password encrypts your saved session credentials. It cannot be recovered if lost."
            : "Enter your master password to access saved session credentials."}
        </p>

        <input
          className={inputCls}
          type="password"
          placeholder="Master password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus
        />
        {creating && (
          <input
            className={inputCls}
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        )}

        {error && (
          <p className="rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            onClick={() => close(false)}
            className="text-xs text-(--text-dim) underline-offset-2 hover:underline"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-(--accent) px-4 py-1.5 text-sm text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)] disabled:opacity-50"
          >
            {busy ? "…" : creating ? "Create" : "Unlock"}
          </button>
        </div>
      </form>
    </div>
  );
}
