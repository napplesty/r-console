import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "../lib/monaco";
import { useAppStore } from "../state/store";
import { getTheme } from "../lib/themes";
import FloatingWindow from "./ui/FloatingWindow";

interface FileViewerProps {
  /** SSH connection key; undefined reads/writes the local filesystem. */
  connKey?: string;
  remotePath: string;
  /** 1-based line to reveal and focus (used by grep results). */
  line?: number;
  /** Floating-window placement: viewport position and stacking order. */
  initialX: number;
  initialY: number;
  z: number;
  onFocus: () => void;
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

/** Floating editor for a remote or local text file; saves back in place. */
export default function FileViewer({
  connKey,
  remotePath,
  line,
  initialX,
  initialY,
  z,
  onFocus,
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
      await (connKey
        ? invoke("sftp_write_text", {
            connKey,
            remotePath,
            content: editor.getValue(),
          })
        : invoke("localfs_write_text", {
            path: remotePath,
            content: editor.getValue(),
          }));
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
    (connKey
      ? invoke<string>("sftp_read_text", { connKey, remotePath })
      : invoke<string>("localfs_read_text", { path: remotePath })
    )
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

  // A grep hit can retarget an already-open window; jump to the new line.
  useEffect(() => {
    if (!line || line <= 0) return;
    const editor = editorRef.current;
    if (!editor || loading) return;
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
    editor.focus();
  }, [line, loading]);

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };

  return (
    <FloatingWindow
      title={
        <>
          {remotePath}
          {dirty && <span className="ml-1 text-amber-400">●</span>}
        </>
      }
      actions={
        <>
          {notice && <span className="text-xs text-(--text-dim)">{notice}</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded bg-(--accent) px-3 py-1 text-xs text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)] disabled:opacity-40"
            title="Save (Cmd/Ctrl+S)"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
      onClose={close}
      onFocus={onFocus}
      z={z}
      initialX={initialX}
      initialY={initialY}
    >
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
    </FloatingWindow>
  );
}
