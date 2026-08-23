import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import MdiIcon from "@mdi/react";
import { mdiMinus, mdiPlus, mdiRefresh, mdiSourceBranch } from "@mdi/js";
import type { GitStatus, GitStatusEntry } from "../lib/types";

// Monaco is heavy (~3 MB): split it out of the main bundle and load it only
// when a diff is actually opened.
const GitDiffViewer = lazy(() => import("./GitDiffViewer"));

interface GitPanelProps {
  /** SSH connection key; undefined for local sessions. */
  connKey?: string;
  /** Latest cwd reported by the active terminal (OSC 7); panel follows it. */
  terminalCwd?: string;
  onClose: () => void;
}

/** Text color for a porcelain status letter badge. */
function badgeClass(letter: string): string {
  switch (letter) {
    case "M":
      return "text-amber-400";
    case "A":
      return "text-green-400";
    case "D":
      return "text-red-400";
    case "R":
    case "C":
      return "text-blue-400";
    default:
      return "text-(--text-dim)";
  }
}

/** MobaXterm-style Git side panel: status, staging and commits for the repo
 *  at the active terminal's working directory (local or over SSH). */
export default function GitPanel({
  connKey,
  terminalCwd,
  onClose,
}: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [diffing, setDiffing] = useState<{ path: string; staged: boolean } | null>(
    null,
  );

  const baseArgs = { connKey: connKey ?? null, cwd: terminalCwd ?? null };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const st = await invoke<GitStatus>("git_status", baseArgs);
      setStatus(st);
      setMessage(null);
    } catch (err) {
      setStatus(null);
      setMessage(String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connKey, terminalCwd]);

  // Load on open and follow the terminal's working directory (MobaXterm-style).
  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (command: string, args: Record<string, unknown>) => {
    try {
      await invoke(command, { ...baseArgs, ...args });
      await refresh();
    } catch (err) {
      setMessage(String(err));
    }
  };

  const stage = (paths: string[]) => run("git_stage", { paths });
  const unstage = (paths: string[]) => run("git_unstage", { paths });

  const commit = async () => {
    if (committing) return;
    setCommitting(true);
    try {
      const out = await invoke<string>("git_commit", {
        ...baseArgs,
        message: commitMsg.trim(),
      });
      setCommitMsg("");
      setMessage(out.trim().split("\n")[0] || "Committed");
      await refresh();
    } catch (err) {
      setMessage(String(err));
    } finally {
      setCommitting(false);
    }
  };

  const entries = status?.entries ?? [];
  const staged = entries.filter(
    (e) => e.stagedState !== "." && e.stagedState !== "?",
  );
  const changes = entries.filter(
    (e) => e.stagedState !== "?" && e.unstagedState !== ".",
  );
  const untracked = entries.filter((e) => e.stagedState === "?");

  const iconBtn =
    "flex items-center gap-1 rounded px-2 py-1 text-xs text-(--text) hover:bg-white/10 disabled:opacity-40";
  const fileBtn =
    "flex items-center rounded px-1 text-(--text-dim) hover:bg-white/10 hover:text-(--text)";

  const renderGroup = (
    title: string,
    files: GitStatusEntry[],
    badgeOf: (e: GitStatusEntry) => string,
    action: { icon: string; title: string; run: (paths: string[]) => void },
    stagedView: boolean,
  ) =>
    files.length > 0 && (
      <div key={title}>
        <div className="flex items-center justify-between px-2 pt-2 pb-0.5">
          <span className="text-xs font-semibold text-(--text-dim)">
            {title} ({files.length})
          </span>
          <button
            className={fileBtn}
            title={action.title}
            onClick={() => action.run(files.map((f) => f.path))}
          >
            <MdiIcon path={action.icon} size="14px" />
            <span className="text-xs">All</span>
          </button>
        </div>
        {files.map((f) => (
          <div
            key={`${title}:${f.path}`}
            onClick={() => setDiffing({ path: f.path, staged: stagedView })}
            className="flex cursor-pointer items-center justify-between rounded px-2 py-1 text-sm hover:bg-white/5"
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={`w-3 shrink-0 text-center text-xs font-bold ${badgeClass(badgeOf(f))}`}
              >
                {badgeOf(f)}
              </span>
              <span className="truncate text-(--text)">{f.path}</span>
            </span>
            <button
              className={`${fileBtn} shrink-0`}
              title={action.title.replace(" all", "")}
              onClick={(ev) => {
                ev.stopPropagation();
                action.run([f.path]);
              }}
            >
              <MdiIcon path={action.icon} size="14px" />
            </button>
          </div>
        ))}
      </div>
    );

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-(--border) bg-(--panel)">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-(--border) px-3">
        <span className="text-sm font-semibold text-(--text)">Git</span>
        <div className="flex gap-1">
          <button
            className={iconBtn}
            onClick={refresh}
            disabled={loading}
            title="Refresh"
          >
            <MdiIcon path={mdiRefresh} size="16px" />
          </button>
          <button className={iconBtn} onClick={onClose} title="Close panel">
            ×
          </button>
        </div>
      </div>

      <div
        className="truncate border-b border-(--border) px-3 py-1.5 text-xs text-(--text-dim)"
        title={terminalCwd ?? "Session home"}
      >
        {terminalCwd ?? "~"}
      </div>

      {status?.isRepo && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-(--border) px-3 py-1.5 text-xs">
          <MdiIcon
            path={mdiSourceBranch}
            size="14px"
            className="shrink-0 text-(--accent)"
          />
          <span className="truncate text-(--text)">
            {status.branch || "(no branch)"}
          </span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="shrink-0 text-(--text-dim)">
              {status.ahead > 0 && ` ↑${status.ahead}`}
              {status.behind > 0 && ` ↓${status.behind}`}
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading && !status && (
          <p className="px-2 py-4 text-center text-xs text-(--text-dim)">
            Loading…
          </p>
        )}
        {status && !status.isRepo && (
          <p className="px-3 py-4 text-center text-xs text-(--text-dim)">
            Not a git repository.
            <br />
            The panel follows the terminal&apos;s working directory — cd into a
            repo to use it.
          </p>
        )}
        {status?.isRepo && entries.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-(--text-dim)">
            Working tree clean
          </p>
        )}
        {status?.isRepo && (
          <>
            {renderGroup(
              "Staged",
              staged,
              (e) => e.stagedState,
              { icon: mdiMinus, title: "Unstage all", run: unstage },
              true,
            )}
            {renderGroup(
              "Changes",
              changes,
              (e) => e.unstagedState,
              { icon: mdiPlus, title: "Stage all", run: stage },
              false,
            )}
            {renderGroup(
              "Untracked",
              untracked,
              () => "?",
              { icon: mdiPlus, title: "Stage all", run: stage },
              false,
            )}
          </>
        )}
      </div>

      {status?.isRepo && (
        <div className="shrink-0 border-t border-(--border) p-2">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message"
            rows={3}
            className="w-full resize-none rounded border border-(--border) bg-(--bg) px-2 py-1 text-xs text-(--text) outline-none placeholder:text-(--text-dim) focus:border-(--accent)"
          />
          <button
            onClick={commit}
            disabled={staged.length === 0 || !commitMsg.trim() || committing}
            className="mt-1.5 w-full rounded bg-(--accent) px-3 py-1 text-xs text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)] disabled:opacity-40"
            title={
              staged.length === 0 ? "Stage changes first" : "Commit staged changes"
            }
          >
            {committing ? "Committing…" : `Commit ${staged.length > 0 ? `(${staged.length} staged)` : ""}`}
          </button>
        </div>
      )}

      {message && (
        <div className="shrink-0 truncate border-t border-(--border) px-3 py-1.5 text-xs text-(--text-dim)">
          {message}
        </div>
      )}

      {diffing && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 text-sm text-(--text-dim)">
              Loading editor…
            </div>
          }
        >
          <GitDiffViewer
            connKey={connKey}
            cwd={terminalCwd}
            path={diffing.path}
            staged={diffing.staged}
            onClose={() => setDiffing(null)}
          />
        </Suspense>
      )}
    </aside>
  );
}
