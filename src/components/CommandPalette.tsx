import { useEffect, useMemo, useRef, useState } from "react";
import MdiIcon from "@mdi/react";
import {
  mdiBroadcast,
  mdiClose,
  mdiCogOutline,
  mdiConsole,
  mdiPalette,
  mdiSsh,
  mdiUpdate,
  mdiViewSplitHorizontal,
  mdiViewSplitVertical,
} from "@mdi/js";
import { useAppStore } from "../state/store";
import {
  openLocalTab,
  splitActivePane,
  sshConfigAsSaved,
  tryConnectSaved,
} from "../state/sessions";
import { THEMES } from "../lib/themes";
import { checkForUpdates } from "../lib/updater";
import ConnectDialog from "./ConnectDialog";
import type { SavedSession } from "../lib/types";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

/**
 * Tiny fuzzy scorer: exact substring wins (prefix > infix), then subsequence.
 * Returns null when there is no match.
 */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 100 - t.length;
  const idx = t.indexOf(q);
  if (idx > 0) return 50 - idx;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i += 1;
  return i === q.length ? 10 : null;
}

/** Command palette (Cmd/Ctrl+K): fuzzy access to actions, themes, sessions. */
export default function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const savedSessions = useAppStore((s) => s.savedSessions);
  const sshConfigHosts = useAppStore((s) => s.sshConfigHosts);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Fallback connect dialog for sessions without resolvable credentials.
  const [dialog, setDialog] = useState<SavedSession | null | undefined>(
    undefined,
  );

  // Reset the draft state whenever the palette is reopened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  const connect = async (s: SavedSession) => {
    setOpen(false);
    if (!(await tryConnectSaved(s))) setDialog(s);
  };

  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [
      {
        id: "new-ssh",
        label: "New SSH connection…",
        icon: mdiSsh,
        run: () => setDialog(null),
      },
      {
        id: "new-local",
        label: "New local terminal",
        icon: mdiConsole,
        run: () => openLocalTab().catch(() => {}),
      },
      {
        id: "check-updates",
        label: "Check for updates…",
        icon: mdiUpdate,
        run: () => void checkForUpdates(false),
      },
      {
        id: "open-settings",
        label: "Open settings…",
        icon: mdiCogOutline,
        run: () => useAppStore.getState().setSettingsOpen(true),
      },
    ];
    if (activeTabId) {
      all.push(
        {
          id: "split-right",
          label: "Split right (duplicate pane)",
          icon: mdiViewSplitVertical,
          run: () => splitActivePane("horizontal").catch(() => {}),
        },
        {
          id: "split-down",
          label: "Split down (duplicate pane)",
          icon: mdiViewSplitHorizontal,
          run: () => splitActivePane("vertical").catch(() => {}),
        },
        {
          id: "broadcast",
          label: "Toggle broadcast input (MultiExec)",
          icon: mdiBroadcast,
          run: () => useAppStore.getState().toggleBroadcast(activeTabId),
        },
        {
          id: "close-tab",
          label: "Close active tab",
          icon: mdiClose,
          run: () => useAppStore.getState().closeTab(activeTabId),
        },
      );
    }
    for (const theme of Object.values(THEMES)) {
      all.push({
        id: `theme-${theme.id}`,
        label: `Theme: ${theme.label}`,
        icon: mdiPalette,
        run: () => useAppStore.getState().setThemeId(theme.id),
      });
    }
    for (const s of savedSessions) {
      all.push({
        id: `session-${s.id}`,
        label: `Connect: ${s.name}`,
        hint: `${s.username}@${s.host}:${s.port}`,
        icon: mdiSsh,
        run: () => void connect(s),
      });
    }
    for (const h of sshConfigHosts) {
      all.push({
        id: `sshconfig-${h.alias}`,
        label: `Connect: ${h.alias}`,
        hint: `${h.user ? `${h.user}@` : ""}${h.hostName}`,
        icon: mdiSsh,
        run: () => void connect(sshConfigAsSaved(h)),
      });
    }
    return all;
    // connect is stable enough for our purposes; rebuild on data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSessions, sshConfigHosts, activeTabId, tabs.length]);

  const filtered = useMemo(() => {
    return items
      .map((item) => ({
        item,
        score: fuzzyScore(query, item.label) ?? fuzzyScore(query, item.hint ?? ""),
      }))
      .filter((x): x is { item: PaletteItem; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [items, query]);

  useEffect(() => setSelected(0), [query]);

  // Keep the selected row visible while navigating with the keyboard.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) {
    // The fallback dialog must survive the palette closing.
    return dialog !== undefined ? (
      <ConnectDialog prefill={dialog} onClose={() => setDialog(undefined)} />
    ) : null;
  }

  const pick = (item: PaletteItem) => {
    setOpen(false);
    item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex w-[32rem] flex-col overflow-hidden rounded-lg border border-(--border) bg-(--panel-alt) shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((i) => Math.min(i + 1, filtered.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((i) => Math.max(i - 1, 0));
            }
            if (e.key === "Enter" && filtered[selected]) pick(filtered[selected]);
          }}
          placeholder="Type a command or search sessions…"
          className="border-b border-(--border) bg-transparent px-4 py-3 text-sm text-(--text) outline-none placeholder:text-(--text-dim)"
        />
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-(--text-dim)">
              No matches
            </p>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              data-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onClick={() => pick(item)}
              className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm ${
                i === selected
                  ? "bg-(--accent) text-white"
                  : "text-(--text)"
              }`}
            >
              <MdiIcon path={item.icon} size="16px" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span
                  className={`truncate text-xs ${
                    i === selected ? "text-white/70" : "text-(--text-dim)"
                  }`}
                >
                  {item.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
