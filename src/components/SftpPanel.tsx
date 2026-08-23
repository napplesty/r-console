import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import MdiIcon from "@mdi/react";
import {
  mdiArrowUp,
  mdiDownload,
  mdiFileCodeOutline,
  mdiFileDocumentOutline,
  mdiFileImageOutline,
  mdiFileOutline,
  mdiFolder,
  mdiRefresh,
  mdiUpload,
} from "@mdi/js";
import type { SftpDirListing, SftpEntry } from "../lib/types";

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

/** Remote file browser bound to one SSH connection. */
export default function SftpPanel({ connKey, terminalCwd, connAlive = true }: SftpPanelProps) {
  const [path, setPath] = useState("~");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

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

  const goUp = () => {
    const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    load(parent === "" ? "/" : parent);
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

  const iconBtn =
    "flex items-center gap-1 rounded px-2 py-1 text-xs text-(--text) hover:bg-white/10 disabled:opacity-40";

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-(--border) bg-(--panel)">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-(--border) px-3">
        <span className="text-sm font-semibold text-(--text)">Files</span>
        <div className="flex gap-1">
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

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading && (
          <p className="px-2 py-4 text-center text-xs text-(--text-dim)">
            Loading…
          </p>
        )}
        {!loading &&
          entries.map((e) => (
            <div
              key={e.path}
              onClick={() => !e.isDir && setViewing(e.path)}
              onDoubleClick={() => e.isDir && load(e.path)}
              className="flex cursor-pointer items-center justify-between rounded px-2 py-1 text-sm hover:bg-white/5"
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

      {message && (
        <div className="shrink-0 truncate border-t border-(--border) px-3 py-1.5 text-xs text-(--text-dim)">
          {message}
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
            connKey={connKey}
            remotePath={viewing}
            onClose={() => setViewing(null)}
          />
        </Suspense>
      )}
    </aside>
  );
}
