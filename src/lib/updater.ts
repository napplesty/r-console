/**
 * Auto-update via tauri-plugin-updater. Update metadata (latest.json) and
 * signed artifacts are published to GitHub Releases by the release
 * workflow; the minisign public key is baked into tauri.conf.json, the
 * private key lives only in CI secrets.
 *
 * Linux note: only the AppImage payload self-updates; deb/rpm users update
 * through their package manager.
 */
import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

/** The silent startup check runs at most once per app launch. */
let startupChecked = false;

/**
 * Check for updates and, with the user's consent, download, install and
 * restart. Silent mode (app start) swallows "no update" and network
 * errors; interactive mode (command palette) always reports the outcome.
 */
export async function checkForUpdates(silent: boolean): Promise<void> {
  if (silent) {
    if (startupChecked) return;
    startupChecked = true;
  }

  let update;
  try {
    update = await check();
  } catch (err) {
    if (!silent) {
      await message(`Failed to check for updates:\n${err}`, {
        title: "R Console",
        kind: "error",
      });
    }
    return;
  }
  if (!update) {
    if (!silent) {
      await message("You're on the latest version.", { title: "R Console" });
    }
    return;
  }

  const yes = await ask(
    `Version ${update.version} is available (current: ${update.currentVersion}).\n\nDownload and install now?`,
    {
      title: "Update available",
      kind: "info",
      okLabel: "Update",
      cancelLabel: "Later",
    },
  );
  if (!yes) return;

  try {
    await update.downloadAndInstall();
  } catch (err) {
    await message(`Update failed:\n${err}`, {
      title: "R Console",
      kind: "error",
    });
    return;
  }
  const restart = await ask(
    "Update installed. Restart now to apply it?",
    { title: "R Console", okLabel: "Restart", cancelLabel: "Later" },
  );
  if (restart) await relaunch();
}
