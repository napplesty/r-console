/**
 * Minimal Monaco setup: core editor API + Monarch syntax highlighting for
 * most languages, plus the official JSON language service (validation,
 * schema support) which needs its own web worker.
 */
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";

// Register only the languages the file viewer can map to. Each register call
// is tiny; the Monarch tokenizer itself is lazy-loaded on first use.
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/dockerfile/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/go/register";

// Official JSON language service (highlighting + validation). JSON has no
// Monarch tokenizer in Monaco; its support has always been worker-based.
import "monaco-editor/language/json/monaco.contribution";

// Find/replace widget (Ctrl+F / Ctrl+H) for the file viewer; importing the
// controller self-registers the actions and keybindings. The package's
// exports map hides the `esm/vs` prefix (same as `editor/editor.api` above).
import "monaco-editor/editor/contrib/find/browser/findController.js";

self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === "json" ? new JsonWorker() : new EditorWorker(),
};

// Custom editor themes matching the app theme presets (see themes.ts).
// "one-light" uses the built-in "vs" theme and needs no definition here.
monaco.editor.defineTheme("tokyo-night", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "c0caf5" },
    { token: "comment", foreground: "565f89", fontStyle: "italic" },
    { token: "keyword", foreground: "bb9af7" },
    { token: "string", foreground: "9ece6a" },
    { token: "number", foreground: "ff9e64" },
    { token: "type", foreground: "2ac3de" },
    { token: "identifier", foreground: "c0caf5" },
  ],
  colors: {
    "editor.background": "#1a1b26",
    "editor.foreground": "#c0caf5",
    "editor.lineHighlightBackground": "#1f2335",
    "editor.selectionBackground": "#33467c",
    "editorLineNumber.foreground": "#3b4261",
  },
});

monaco.editor.defineTheme("solarized-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "839496" },
    { token: "comment", foreground: "586e75", fontStyle: "italic" },
    { token: "keyword", foreground: "859900" },
    { token: "string", foreground: "2aa198" },
    { token: "number", foreground: "d33682" },
    { token: "type", foreground: "b58900" },
    { token: "identifier", foreground: "839496" },
  ],
  colors: {
    "editor.background": "#002b36",
    "editor.foreground": "#839496",
    "editor.lineHighlightBackground": "#073642",
    "editor.selectionBackground": "#073642",
    "editorLineNumber.foreground": "#586e75",
  },
});

monaco.editor.defineTheme("github-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "c9d1d9" },
    { token: "comment", foreground: "8b949e", fontStyle: "italic" },
    { token: "keyword", foreground: "ff7b72" },
    { token: "string", foreground: "a5d6ff" },
    { token: "number", foreground: "79c0ff" },
    { token: "type", foreground: "79c0ff" },
    { token: "identifier", foreground: "c9d1d9" },
    { token: "identifier.function", foreground: "d2a8ff" },
  ],
  colors: {
    "editor.background": "#0d1117",
    "editor.foreground": "#c9d1d9",
    "editor.lineHighlightBackground": "#161b22",
    "editor.selectionBackground": "#264f78",
    "editorLineNumber.foreground": "#484f58",
  },
});

monaco.editor.defineTheme("github-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "", foreground: "1f2328" },
    { token: "comment", foreground: "59636e", fontStyle: "italic" },
    { token: "keyword", foreground: "cf222e" },
    { token: "string", foreground: "0a3069" },
    { token: "number", foreground: "0550ae" },
    { token: "type", foreground: "0550ae" },
    { token: "identifier", foreground: "1f2328" },
    { token: "identifier.function", foreground: "8250df" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#1f2328",
    "editor.lineHighlightBackground": "#f6f8fa",
    "editor.selectionBackground": "#b6e3ff",
    "editorLineNumber.foreground": "#8c959f",
  },
});

export { monaco };
