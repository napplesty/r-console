import { useState } from "react";
import MdiIcon from "@mdi/react";
import { mdiConsole, mdiConsoleLine, mdiSsh } from "@mdi/js";
import { useAppStore } from "../store";
import { openLocalTab, sshConfigAsSaved, tryConnectSaved } from "../sessions";
import ConnectDialog from "./ConnectDialog";
import type { SavedSession } from "../types";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

const SHORTCUTS: [string, string][] = [
  ["Command palette", `${MOD}K`],
  ["New local terminal", `${MOD}T`],
  ["Close tab", `${MOD}W`],
  ["Split right", `${MOD}D`],
  ["Split down", `${MOD}⇧D`],
  ["Broadcast input", `${MOD}⇧↵`],
];

/**
 * Empty state shown when no tab is open, modeled after the VS Code welcome
 * page: quiet text links instead of cards, sessions as compact rows,
 * shortcuts as a side column.
 */
export default function Welcome() {
  const savedSessions = useAppStore((s) => s.savedSessions);
  const sshConfigHosts = useAppStore((s) => s.sshConfigHosts);
  // undefined = dialog closed; null = blank form; session = prefilled form.
  const [dialog, setDialog] = useState<SavedSession | null | undefined>(
    undefined,
  );

  const connect = async (s: SavedSession) => {
    if (!(await tryConnectSaved(s))) setDialog(s);
  };

  const linkClass =
    "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-(--text) hover:bg-white/5";
  const linkIconClass = "shrink-0 text-(--text-dim)";
  const sectionTitle =
    "px-2 pt-5 pb-1 text-xs font-semibold tracking-wide text-(--text-dim) uppercase";

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="flex w-full max-w-3xl items-start gap-16">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2.5 px-2">
            <MdiIcon
              path={mdiConsoleLine}
              size="26px"
              className="text-(--accent)"
            />
            <div>
              <h1 className="text-base leading-tight font-semibold text-(--text)">
                r-console
              </h1>
              <p className="text-xs text-(--text-dim)">
                Cross-platform terminal &amp; SSH workspace
              </p>
            </div>
          </div>

          <p className={sectionTitle}>Start</p>
          <button onClick={() => setDialog(null)} className={linkClass}>
            <MdiIcon path={mdiSsh} size="16px" className={linkIconClass} />
            New SSH Connection…
          </button>
          <button
            onClick={() => openLocalTab().catch(() => {})}
            className={linkClass}
          >
            <MdiIcon path={mdiConsole} size="16px" className={linkIconClass} />
            New Local Terminal
          </button>

          {(savedSessions.length > 0 || sshConfigHosts.length > 0) && (
            <p className={sectionTitle}>Sessions</p>
          )}
          {savedSessions.map((s) => (
            <button key={s.id} onClick={() => connect(s)} className={linkClass}>
              <MdiIcon path={mdiSsh} size="16px" className={linkIconClass} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 truncate text-xs text-(--text-dim)">
                {s.username}@{s.host}:{s.port}
              </span>
            </button>
          ))}
          {sshConfigHosts.map((h) => (
            <button
              key={h.alias}
              onClick={() => connect(sshConfigAsSaved(h))}
              className={linkClass}
            >
              <MdiIcon path={mdiSsh} size="16px" className={linkIconClass} />
              <span className="min-w-0 flex-1 truncate">{h.alias}</span>
              <span className="shrink-0 truncate text-xs text-(--text-dim)">
                {h.user ? `${h.user}@` : ""}
                {h.hostName}
              </span>
            </button>
          ))}
        </div>

        <div className="w-52 shrink-0 pt-12">
          <p className={`${sectionTitle} pt-0`}>Shortcuts</p>
          {SHORTCUTS.map(([label, keys]) => (
            <div
              key={label}
              className="flex items-center justify-between px-2 py-1 text-xs"
            >
              <span className="text-(--text-dim)">{label}</span>
              <kbd className="rounded border border-(--border) bg-(--panel) px-1.5 py-0.5 font-mono text-[11px] text-(--text-dim)">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>

      {dialog !== undefined && (
        <ConnectDialog prefill={dialog} onClose={() => setDialog(undefined)} />
      )}
    </div>
  );
}
