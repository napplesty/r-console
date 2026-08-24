import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "../lib/monaco";
import { useAppStore } from "../state/store";
import { getTheme } from "../lib/themes";

interface FileViewerProps {
  connKey: string;
  remotePath: string;
  /** 1-based line to reveal and focus (used by grep results). */
  line?: number;
  onClose: () => void;
}

/** File extension → Monaco language id (Monarch highlighting only). */
const EXT_TO_LANGUAGE: Record<string, string> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  // Monaco ships no TOML tokenizer; INI is close enough for preview.
  toml: "ini",
  rs: "rust",
  conf: "ini",
  ini: "ini",
  cfg: "ini",
  md: "markdown",
  xml: "xml",
  html: "xml",
  sql: "sql",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  go: "go",
};

export function languageForPath(remotePath: string): string {
  const name = remotePath.split("/").pop() ?? "";
  if (/^dockerfile/i.test(name)) return "dockerfile";
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}

/** Modal editor for a remote text file; saves back over SFTP. */
export default function FileViewer({
  connKey,
  remotePath,
  line,
  onClose,
}: FileViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const themeId = useAppStore((s) => s.themeId);

  const save = async () => {
    const editor = editorRef.current;
    if (!editor || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await invoke("sftp_write_text", {
        connKey,
        remotePath,
        content: editor.getValue(),
      });
      setDirty(false);
      setNotice("Saved");
    } catch (err) {
      setNotice(`Save failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Create the editor once; fetched content is pushed into the model when it
  // arrives, which may be after the editor has mounted.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.create(host, {
      value: "",
      language: languageForPath(remotePath),
      readOnly: false,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      fontSize: 12,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: getTheme(useAppStore.getState().themeId).monaco,
    });
    editorRef.current = editor;

    const dirtyDisposable = editor.onDidChangeModelContent(() =>
      setDirty(true),
    );
    // Cmd/Ctrl+S inside the editor saves back to the server.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );

    let cancelled = false;
    invoke<string>("sftp_read_text", { connKey, remotePath })
      .then((text) => {
        if (cancelled) return;
        editor.setValue(text);
        setDirty(false);
        setLoading(false);
        if (line && line > 0) {
          editor.setPosition({ lineNumber: line, column: 1 });
          editor.revealLineInCenter(line);
          editor.focus();
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      dirtyDisposable.dispose();
      editorRef.current = null;
      const model = editor.getModel();
      editor.dispose();
      model?.dispose();
    };
  }, [connKey, remotePath]);

  // Monaco themes are global; follow the app theme while the viewer is open.
  useEffect(() => {
    monaco.editor.setTheme(getTheme(themeId).monaco);
  }, [themeId]);

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[70vh] w-[46rem] max-w-[90vw] flex-col rounded-lg border border-(--border) bg-(--panel-alt) shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
          <span className="min-w-0 truncate text-sm text-(--text)">
            {remotePath}
            {dirty && <span className="ml-1 text-amber-400">●</span>}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {notice && (
              <span className="text-xs text-(--text-dim)">{notice}</span>
            )}
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="rounded bg-(--accent) px-3 py-1 text-xs text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)] disabled:opacity-40"
              title="Save (Cmd/Ctrl+S)"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={close}
              className="rounded px-2 py-0.5 text-(--text-dim) hover:bg-white/10 hover:text-(--text)"
            >
              ×
            </button>
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <div ref={hostRef} className="absolute inset-0" />
          {error && (
            <p className="absolute inset-0 p-4 text-sm text-red-400">{error}</p>
          )}
          {!error && loading && (
            <p className="absolute inset-0 p-4 text-sm text-(--text-dim)">
              Loading…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
