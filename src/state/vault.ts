import { useAppStore } from "./store";

type UnlockResolver = (unlocked: boolean) => void;

/** Waiters blocked on the vault being unlocked (resolved by VaultDialog). */
let resolvers: UnlockResolver[] = [];

/**
 * Open the vault unlock dialog and resolve with `true` once the vault is
 * unlocked, or `false` if the user skips/closes the dialog.
 */
export function requestVaultUnlock(): Promise<boolean> {
  return new Promise((resolve) => {
    resolvers.push(resolve);
    useAppStore.getState().setVaultDialogOpen(true);
  });
}

/** Called by VaultDialog when it closes; settles every pending waiter. */
export function settleVaultUnlock(unlocked: boolean): void {
  const pending = resolvers.splice(0);
  for (const r of pending) r(unlocked);
  useAppStore.getState().setVaultDialogOpen(false);
}

/**
 * Run a credential operation; on a "Vault is locked" error open the unlock
 * dialog and retry once after a successful unlock. Resolves to `null` when
 * the user skips unlocking or the retry fails. Errors for any other reason
 * (on the first attempt) are rethrown so callers can surface them.
 */
export async function withVaultRetry<T>(
  op: () => Promise<T>,
): Promise<T | null> {
  try {
    return await op();
  } catch (err) {
    if (!String(err).includes("Vault is locked")) throw err;
    const unlocked = await requestVaultUnlock();
    if (!unlocked) return null;
    return await op().catch(() => null);
  }
}
