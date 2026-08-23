import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "../lib/monaco";
import { useAppStore } from "../state/store";
import { getTheme } from "../lib/themes";
import { languageForPath } from "./FileViewer";

interface GitDiffViewerProps {
  /** SSH connection key; undefined for local sessions. */
  connKey?: string;
  /** Repo working directory (from the terminal's OSC 7 report). */
  cwd?: string;
  path: string;
  /** True shows the staged diff (HEAD vs index), false the unstaged diff
   *  (index vs worktree); untracked files show as fully added. */
  staged: boolean;
  onClose: () => void;
}

/** Read-only modal diff for one changed file, backed by Monaco's DiffEditor.
 *  Falls back to the plain unified diff text when file contents cannot be
 *  loaded (e.g. binary files). */
export default function GitDiffViewer({
  connKey,
  cwd,
  path,
  staged,
  onClose,
}: GitDiffViewerProps) {
  const [loading, setLoading] = useState(true);
  const [fallbackDiff, setFallbackDiff] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const themeId = useAppStore((s) => s.themeId);

  // Create the diff editor once; content is pushed into models when it
  // arrives, which may be after the editor has mounted.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const diffEditor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontSize: 12,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: getTheme(useAppStore.getState().themeId).monaco,
    });

    let cancelled = false;
    const load = async () => {
      // Staged: HEAD vs index. Unstaged: index vs worktree.
      const [origSource, modSource] = staged
        ? (["head", "index"] as const)
        : (["index", "worktree"] as const);
      const args = { connKey: connKey ?? null, cwd: cwd ?? null, path };
      try {
        const [orig, mod] = await Promise.all([
          invoke<string>("git_file_content", { ...args, source: origSource }),
          invoke<string>("git_file_content", { ...args, source: modSource }),
        ]);
        if (cancelled) return;
        const language = languageForPath(path);
        diffEditor.setModel({
          original: monaco.editor.createModel(orig, language),
          modified: monaco.editor.createModel(mod, language),
        });
        setLoading(false);
      } catch {
        // Binary or unreadable file: show the unified diff text instead.
        try {
          const text = await invoke<string>("git_diff", { ...args, staged });
          if (cancelled) return;
          setFallbackDiff(text || "(no textual diff available)");
        } catch (err) {
          if (cancelled) return;
          setFallbackDiff(String(err));
        }
        setLoading(false);
      }
    };
    void load();

    return () => {
      cancelled = true;
      const model = diffEditor.getModel();
      diffEditor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
  }, [connKey, cwd, path, staged]);

  // Monaco themes are global; follow the app theme while the viewer is open.
  useEffect(() => {
    monaco.editor.setTheme(getTheme(themeId).monaco);
  }, [themeId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[70vh] w-[56rem] max-w-[90vw] flex-col rounded-lg border border-(--border) bg-(--panel-alt) shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
          <span className="min-w-0 truncate text-sm text-(--text)">
            {path}
            <span className="ml-2 text-xs text-(--text-dim)">
              {staged ? "staged changes" : "unstaged changes"}
            </span>
          </span>
          <button
            onClick={onClose}
            className="shrink-0 rounded px-2 py-0.5 text-(--text-dim) hover:bg-white/10 hover:text-(--text)"
          >
            ×
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <div ref={hostRef} className="absolute inset-0" />
          {fallbackDiff !== null && (
            <pre className="absolute inset-0 overflow-auto bg-(--bg) p-4 text-xs whitespace-pre-wrap text-(--text)">
              {fallbackDiff}
            </pre>
          )}
          {loading && (
            <p className="absolute inset-0 p-4 text-sm text-(--text-dim)">
              Loading…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
