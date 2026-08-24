import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import MdiIcon from "@mdi/react";
import {
  mdiArrowUp,
  mdiClose,
  mdiConsoleLine,
  mdiContentCopy,
  mdiDeleteOutline,
  mdiDownload,
  mdiFileCodeOutline,
  mdiFileDocumentOutline,
  mdiFileImageOutline,
  mdiFileOutline,
  mdiFilePlusOutline,
  mdiFolder,
  mdiFolderOpenOutline,
  mdiFolderPlusOutline,
  mdiMagnify,
  mdiPencilOutline,
  mdiRefresh,
  mdiUpload,
} from "@mdi/js";
import type { SftpDirListing, SftpEntry, SshGrepHit } from "../lib/types";
import { openSshTab, resolveSavedSessionConfig } from "../state/sessions";
import { useAppStore } from "../state/store";

// Monaco is heavy (~3 MB): split it out of the main bundle and load it only
// when a file is actually opened.
const FileViewer = lazy(() => import("./FileViewer"));

interface SftpPanelProps {
  connKey: string;
  /** Latest cwd reported by the active terminal (OSC 7); panel follows it. */
  terminalCwd?: string;
  /**
   * Connection health of the driving pane. A reconnect replaces the backend
   * connection under the same connKey, so the panel reloads when the pane
   * returns to live after a reconnect.
   */
  connAlive?: boolean;
}

function formatSize(size?: number | null): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function parentDir(p: string): string {
  const parent = p.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return parent === "" ? "/" : parent;
}

/** File extension → Material icon for the file list. */
const EXT_TO_FILE_ICON: Record<string, string> = {
  sh: mdiFileCodeOutline,
  bash: mdiFileCodeOutline,
  zsh: mdiFileCodeOutline,
  py: mdiFileCodeOutline,
  js: mdiFileCodeOutline,
  mjs: mdiFileCodeOutline,
  cjs: mdiFileCodeOutline,
  jsx: mdiFileCodeOutline,
  ts: mdiFileCodeOutline,
  mts: mdiFileCodeOutline,
  cts: mdiFileCodeOutline,
  tsx: mdiFileCodeOutline,
  rs: mdiFileCodeOutline,
  go: mdiFileCodeOutline,
  c: mdiFileCodeOutline,
  h: mdiFileCodeOutline,
  cpp: mdiFileCodeOutline,
  json: mdiFileCodeOutline,
  yaml: mdiFileCodeOutline,
  yml: mdiFileCodeOutline,
  toml: mdiFileCodeOutline,
  png: mdiFileImageOutline,
  jpg: mdiFileImageOutline,
  jpeg: mdiFileImageOutline,
  svg: mdiFileImageOutline,
  gif: mdiFileImageOutline,
  md: mdiFileDocumentOutline,
  txt: mdiFileDocumentOutline,
};

function fileIconFor(name: string): string {
  const ext = name.includes(".")
    ? (name.split(".").pop() ?? "").toLowerCase()
    : "";
  return EXT_TO_FILE_ICON[ext] ?? mdiFileOutline;
}

/** Right-click context menu state; `entry` is null for the list background. */
interface MenuState {
  x: number;
  y: number;
  entry: SftpEntry | null;
}

/** Name-input dialog for rename / new file / new folder. */
interface PromptState {
  mode: "rename" | "newFile" | "newFolder";
  entry?: SftpEntry;
  value: string;
}

const menuItemClass =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-(--text) hover:bg-white/5";

/** Remote file browser bound to one SSH connection. */
export default function SftpPanel({ connKey, terminalCwd, connAlive = true }: SftpPanelProps) {
  const [path, setPath] = useState("~");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ path: string; line?: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SftpEntry | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SshGrepHit[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setMessage(null);
      try {
        const listing = await invoke<SftpDirListing>("sftp_list_dir", {
          connKey,
          path: p,
        });
        setPath(listing.path);
        setEntries(listing.entries);
        setSelected(null);
      } catch (err) {
        setMessage(String(err));
      } finally {
        setLoading(false);
      }
    },
    [connKey],
  );

  useEffect(() => {
    setPath("~");
    load("~");
  }, [load]);

  // The connKey survives a reconnect (it identifies the host, not the
  // transport), so watch the pane's health instead: when it returns to live
  // after a reconnect, reload the current directory against the fresh
  // backend connection.
  const wasAlive = useRef(true);
  useEffect(() => {
    const prev = wasAlive.current;
    wasAlive.current = connAlive;
    if (connAlive && !prev) load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connAlive]);

  // Follow the terminal's working directory (MobaXterm-style), but only
  // when it actually changed to avoid reload loops.
  useEffect(() => {
    if (terminalCwd && terminalCwd !== path) {
      load(terminalCwd);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalCwd]);

  const goUp = () => load(parentDir(path));

  const openEntry = (e: SftpEntry) => {
    if (e.isDir) load(e.path);
    else setViewing({ path: e.path });
  };

  const download = async (entry: SftpEntry) => {
    const local = await save({ defaultPath: entry.name });
    if (!local) return;
    setMessage(`Downloading ${entry.name}…`);
    try {
      await invoke("sftp_download", {
        connKey,
        remotePath: entry.path,
        localPath: local,
        transferId: crypto.randomUUID(),
        fileName: entry.name,
      });
      setMessage(`Downloaded ${entry.name}`);
    } catch (err) {
      setMessage(String(err));
    }
  };

  const upload = async () => {
    const local = await open({ multiple: false });
    if (!local) return;
    const remote = `${path.replace(/\/+$/, "")}/${baseName(local)}`;
    setMessage(`Uploading ${baseName(local)}…`);
    try {
      await invoke("sftp_upload", {
        connKey,
        localPath: local,
        remotePath: remote,
        transferId: crypto.randomUUID(),
        fileName: baseName(local),
      });
      setMessage(`Uploaded ${baseName(local)}`);
      await load(path);
    } catch (err) {
      setMessage(String(err));
    }
  };

  const copyPath = (p: string) => {
    navigator.clipboard.writeText(p).catch(() => {});
    setMessage("Path copied");
  };

  const doDelete = async (entry: SftpEntry) => {
    setConfirmDelete(null);
    setMessage(`Deleting ${entry.name}…`);
    try {
      await invoke("sftp_delete", {
        connKey,
        path: entry.path,
        isDir: entry.isDir,
      });
      setMessage(`Deleted ${entry.name}`);
      await load(path);
    } catch (err) {
      setMessage(String(err));
    }
  };

  const submitPrompt = async () => {
    if (!prompt) return;
    const name = prompt.value.trim();
    if (!name || name.includes("/")) {
      setMessage("Invalid name");
      return;
    }
    setPrompt(null);
    try {
      if (prompt.mode === "rename" && prompt.entry) {
        const newPath = `${parentDir(prompt.entry.path).replace(/\/+$/, "")}/${name}`;
        await invoke("sftp_rename", {
          connKey,
          oldPath: prompt.entry.path,
          newPath,
        });
        setMessage(`Renamed to ${name}`);
      } else if (prompt.mode === "newFolder") {
        await invoke("sftp_mkdir", {
          connKey,
          path: `${path.replace(/\/+$/, "")}/${name}`,
        });
        setMessage(`Created ${name}`);
      } else {
        // New file: sftp_write_text creates (or truncates) the file.
        await invoke("sftp_write_text", {
          connKey,
          remotePath: `${path.replace(/\/+$/, "")}/${name}`,
          content: "",
        });
        setMessage(`Created ${name}`);
      }
      await load(path);
    } catch (err) {
      setMessage(String(err));
    }
  };

  // Open a new terminal tab on this host, landed in the given directory.
  // Reuses the connect config of any live pane on this connection; the fresh
  // pane gets its own tmux session (tmuxSession reset).
  const openTerminalHere = async (dir: string) => {
    const { tabs } = useAppStore.getState();
    for (const tab of tabs) {
      for (const pane of tab.panes) {
        if (pane.connKey !== connKey) continue;
        let config = pane.connectConfig;
        if (!config && pane.saved) {
          config =
            (await resolveSavedSessionConfig(pane.saved)) ?? undefined;
        }
        if (!config) continue;
        try {
          await openSshTab(
            { ...config, tmuxSession: undefined, cwd: dir },
            `${config.host}: ${baseName(dir)}`,
            pane.saved,
          );
        } catch (err) {
          setMessage(String(err));
        }
        return;
      }
    }
    setMessage("No live pane for this connection");
  };

  const runSearch = async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    setMessage(null);
    try {
      const result = await invoke<SshGrepHit[]>("ssh_grep", {
        connKey,
        path,
        query: q,
      });
      setHits(result);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSearching(false);
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setHits(null);
    setSearchQuery("");
  };

  // Keyboard navigation on the file list (VSCode-style basics).
  const onListKeyDown = (ev: React.KeyboardEvent) => {
    if (menu || prompt || confirmDelete || hits) return;
    const idx = entries.findIndex((e) => e.path === selected);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const next =
        ev.key === "ArrowDown"
          ? Math.min(idx + 1, entries.length - 1)
          : Math.max(idx - 1, 0);
      setSelected(entries[next]?.path ?? null);
    } else if (ev.key === "Enter" && idx >= 0) {
      openEntry(entries[idx]);
    } else if ((ev.key === "Delete" || ev.key === "Backspace") && idx >= 0) {
      setConfirmDelete(entries[idx]);
    } else if (ev.key === "F2" && idx >= 0) {
      setPrompt({ mode: "rename", entry: entries[idx], value: entries[idx].name });
    } else if (ev.key === "Escape") {
      setSelected(null);
      if (searchOpen) closeSearch();
    }
  };

  const openMenu = (ev: React.MouseEvent, entry: SftpEntry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (entry) setSelected(entry.path);
    setMenu({ x: ev.clientX, y: ev.clientY, entry });
  };

  const iconBtn =
    "flex items-center gap-1 rounded px-2 py-1 text-xs text-(--text) hover:bg-white/10 disabled:opacity-40";

  const MenuItem = ({
    icon,
    label,
    onClick,
    danger = false,
  }: {
    icon: string;
    label: string;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <button
      onClick={() => {
        setMenu(null);
        onClick();
      }}
      className={`${menuItemClass} ${danger ? "text-red-400" : ""}`}
    >
      <MdiIcon path={icon} size="14px" />
      {label}
    </button>
  );

  const promptTitle =
    prompt?.mode === "rename"
      ? `Rename ${prompt.entry?.name}`
      : prompt?.mode === "newFolder"
        ? "New folder"
        : "New file";

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-(--border) bg-(--panel)">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-(--border) px-3">
        <span className="text-sm font-semibold text-(--text)">Files</span>
        <div className="flex gap-1">
          <button
            className={iconBtn}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            title="Search in directory contents"
          >
            <MdiIcon path={mdiMagnify} size="16px" />
          </button>
          <button className={iconBtn} onClick={goUp} title="Parent directory">
            <MdiIcon path={mdiArrowUp} size="16px" />
          </button>
          <button
            className={iconBtn}
            onClick={() => load(path)}
            disabled={loading}
            title="Refresh"
          >
            <MdiIcon path={mdiRefresh} size="16px" />
          </button>
          <button className={iconBtn} onClick={upload} title="Upload file">
            <MdiIcon path={mdiUpload} size="16px" />
            Upload
          </button>
        </div>
      </div>

      <div
        className="truncate border-b border-(--border) px-3 py-1.5 text-xs text-(--text-dim)"
        title={path}
      >
        {path}
      </div>

      {searchOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-(--border) px-2 py-1.5">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
              if (e.key === "Escape") closeSearch();
            }}
            placeholder="Search in files…"
            className="min-w-0 flex-1 rounded border border-(--border) bg-transparent px-2 py-1 text-xs text-(--text) outline-none focus:border-(--accent)"
          />
          <button
            className={iconBtn}
            onClick={runSearch}
            disabled={searching}
            title="Search"
          >
            {searching ? "…" : "Go"}
          </button>
          <button className={iconBtn} onClick={closeSearch} title="Close search">
            <MdiIcon path={mdiClose} size="14px" />
          </button>
        </div>
      )}

      {hits ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          <p className="px-2 py-1 text-xs text-(--text-dim)">
            {hits.length === 0
              ? "No matches"
              : `${hits.length}${hits.length >= 200 ? "+" : ""} match${hits.length === 1 ? "" : "es"}`}
          </p>
          {hits.map((h, i) => (
            <div
              key={`${h.path}:${h.line}:${i}`}
              onClick={() => setViewing({ path: h.path, line: h.line })}
              className="cursor-pointer rounded px-2 py-1 text-xs hover:bg-white/5"
              title={`${h.path}:${h.line}`}
            >
              <span className="block truncate text-(--text)">
                {baseName(h.path)}
                <span className="text-(--text-dim)">:{h.line}</span>
              </span>
              <span className="block truncate text-(--text-dim)">
                {h.preview}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onListKeyDown}
          onContextMenu={(ev) => openMenu(ev, null)}
          className="min-h-0 flex-1 overflow-y-auto p-1 outline-none"
        >
          {loading && (
            <p className="px-2 py-4 text-center text-xs text-(--text-dim)">
              Loading…
            </p>
          )}
          {!loading &&
            entries.map((e) => (
              <div
                key={e.path}
                onClick={() => {
                  setSelected(e.path);
                  if (!e.isDir) setViewing({ path: e.path });
                }}
                onDoubleClick={() => e.isDir && load(e.path)}
                onContextMenu={(ev) => openMenu(ev, e)}
                className={`flex cursor-pointer items-center justify-between rounded px-2 py-1 text-sm hover:bg-white/5 ${
                  selected === e.path ? "bg-white/10" : ""
                }`}
                title={
                  e.isDir ? "Double-click to open" : "Click to preview"
                }
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <MdiIcon
                    path={e.isDir ? mdiFolder : fileIconFor(e.name)}
                    size="16px"
                    className={`shrink-0 ${
                      e.isDir ? "text-(--accent)" : "text-(--text-dim)"
                    }`}
                  />
                  <span className="truncate text-(--text)">{e.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-xs text-(--text-dim)">
                    {e.isDir ? "" : formatSize(e.size)}
                  </span>
                  {!e.isDir && (
                    <button
                      className="flex items-center rounded px-1 text-(--text-dim) hover:bg-white/10 hover:text-(--text)"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        download(e);
                      }}
                      title="Download"
                    >
                      <MdiIcon path={mdiDownload} size="16px" />
                    </button>
                  )}
                </span>
              </div>
            ))}
        </div>
      )}

      {message && (
        <div className="shrink-0 truncate border-t border-(--border) px-3 py-1.5 text-xs text-(--text-dim)">
          {message}
        </div>
      )}

      {menu && (
        <>
          {/* Click-away layer closing the menu */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-50 w-52 rounded border border-(--border) bg-(--panel-alt) py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.entry ? (
              menu.entry.isDir ? (
                <>
                  <MenuItem
                    icon={mdiFolderOpenOutline}
                    label="Open"
                    onClick={() => load(menu.entry!.path)}
                  />
                  <MenuItem
                    icon={mdiConsoleLine}
                    label="New terminal here"
                    onClick={() => void openTerminalHere(menu.entry!.path)}
                  />
                  <MenuItem
                    icon={mdiPencilOutline}
                    label="Rename"
                    onClick={() =>
                      setPrompt({
                        mode: "rename",
                        entry: menu.entry!,
                        value: menu.entry!.name,
                      })
                    }
                  />
                  <MenuItem
                    icon={mdiDeleteOutline}
                    label="Delete"
                    danger
                    onClick={() => setConfirmDelete(menu.entry!)}
                  />
                  <MenuItem
                    icon={mdiContentCopy}
                    label="Copy path"
                    onClick={() => copyPath(menu.entry!.path)}
                  />
                </>
              ) : (
                <>
                  <MenuItem
                    icon={mdiFileOutline}
                    label="Open"
                    onClick={() => setViewing({ path: menu.entry!.path })}
                  />
                  <MenuItem
                    icon={mdiDownload}
                    label="Download"
                    onClick={() => void download(menu.entry!)}
                  />
                  <MenuItem
                    icon={mdiPencilOutline}
                    label="Rename"
                    onClick={() =>
                      setPrompt({
                        mode: "rename",
                        entry: menu.entry!,
                        value: menu.entry!.name,
                      })
                    }
                  />
                  <MenuItem
                    icon={mdiDeleteOutline}
                    label="Delete"
                    danger
                    onClick={() => setConfirmDelete(menu.entry!)}
                  />
                  <MenuItem
                    icon={mdiContentCopy}
                    label="Copy path"
                    onClick={() => copyPath(menu.entry!.path)}
                  />
                </>
              )
            ) : (
              <>
                <MenuItem
                  icon={mdiFilePlusOutline}
                  label="New file"
                  onClick={() => setPrompt({ mode: "newFile", value: "" })}
                />
                <MenuItem
                  icon={mdiFolderPlusOutline}
                  label="New folder"
                  onClick={() => setPrompt({ mode: "newFolder", value: "" })}
                />
                <MenuItem
                  icon={mdiConsoleLine}
                  label="New terminal here"
                  onClick={() => void openTerminalHere(path)}
                />
                <MenuItem
                  icon={mdiUpload}
                  label="Upload"
                  onClick={() => void upload()}
                />
                <MenuItem
                  icon={mdiRefresh}
                  label="Refresh"
                  onClick={() => void load(path)}
                />
                <MenuItem
                  icon={mdiContentCopy}
                  label="Copy path"
                  onClick={() => copyPath(path)}
                />
              </>
            )}
          </div>
        </>
      )}

      {prompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPrompt(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-80 rounded-lg border border-(--border) bg-(--panel-alt) p-4 shadow-xl"
          >
            <p className="mb-2 text-sm text-(--text)">{promptTitle}</p>
            <input
              autoFocus
              value={prompt.value}
              onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitPrompt();
                if (e.key === "Escape") setPrompt(null);
              }}
              className="w-full rounded border border-(--border) bg-transparent px-2 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setPrompt(null)}
                className="rounded px-3 py-1 text-xs text-(--text-dim) hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={() => void submitPrompt()}
                className="rounded bg-(--accent) px-3 py-1 text-xs text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)]"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-96 rounded-lg border border-(--border) bg-(--panel-alt) p-4 shadow-xl"
          >
            <p className="mb-1 text-sm text-(--text)">
              Delete {confirmDelete.isDir ? "directory" : "file"}{" "}
              <span className="font-semibold">{confirmDelete.name}</span>?
            </p>
            <p className="mb-3 truncate text-xs text-(--text-dim)" title={confirmDelete.path}>
              {confirmDelete.path}
              {confirmDelete.isDir && " (recursively)"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="rounded px-3 py-1 text-xs text-(--text-dim) hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={() => void doDelete(confirmDelete)}
                className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {viewing && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 text-sm text-(--text-dim)">
              Loading editor…
            </div>
          }
        >
          <FileViewer
            key={`${viewing.path}:${viewing.line ?? 0}`}
            connKey={connKey}
            remotePath={viewing.path}
            line={viewing.line}
            onClose={() => setViewing(null)}
          />
        </Suspense>
      )}
    </aside>
  );
}
