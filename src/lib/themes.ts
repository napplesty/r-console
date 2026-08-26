import type { ITheme } from "@xterm/xterm";

/** CSS color tokens used for the app chrome (window background, panels). */
export interface ChromeTheme {
  background: string;
  panel: string;
  panelAlt: string;
  border: string;
  foreground: string;
  dim: string;
  accent: string;
}

export interface AppTheme {
  id: string;
  label: string;
  /** Passed to the xterm.js Terminal constructor. */
  xterm: ITheme;
  /**
   * Monaco theme name: a built-in ("vs", "vs-dark") or one of the custom
   * themes registered in monaco.ts.
   */
  monaco: string;
  chrome: ChromeTheme;
}

export const THEMES: Record<string, AppTheme> = {
  "tokyo-night": {
    id: "tokyo-night",
    label: "Tokyo Night",
    xterm: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      selectionBackground: "#33467c",
    },
    monaco: "tokyo-night",
    chrome: {
      background: "#1a1b26",
      panel: "#24283b",
      panelAlt: "#2f3549",
      border: "rgba(255, 255, 255, 0.1)",
      foreground: "#c0caf5",
      dim: "#565f89",
      accent: "#7aa2f7",
    },
  },
  "solarized-dark": {
    id: "solarized-dark",
    label: "Solarized Dark",
    xterm: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
    },
    monaco: "solarized-dark",
    chrome: {
      background: "#002b36",
      panel: "#073642",
      panelAlt: "#0a4352",
      border: "rgba(147, 161, 161, 0.2)",
      foreground: "#839496",
      dim: "#586e75",
      accent: "#268bd2",
    },
  },
  "one-light": {
    id: "one-light",
    label: "One Light",
    xterm: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#526eff",
      selectionBackground: "#d7d7d7",
    },
    monaco: "vs",
    chrome: {
      background: "#fafafa",
      panel: "#ffffff",
      panelAlt: "#f0f0f1",
      border: "#e5e5e6",
      foreground: "#383a42",
      dim: "#a0a1a7",
      accent: "#4078f2",
    },
  },
  "github-dark": {
    id: "github-dark",
    label: "GitHub Dark",
    xterm: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#c9d1d9",
      selectionBackground: "#264f78",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
    monaco: "github-dark",
    chrome: {
      background: "#0d1117",
      panel: "#161b22",
      panelAlt: "#21262d",
      border: "#30363d",
      foreground: "#c9d1d9",
      dim: "#8b949e",
      accent: "#1f6feb",
    },
  },
  "github-light": {
    id: "github-light",
    label: "GitHub Light",
    xterm: {
      background: "#ffffff",
      foreground: "#1f2328",
      cursor: "#1f2328",
      selectionBackground: "#b6e3ff",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#9a6700",
      brightBlue: "#0550ae",
      brightMagenta: "#6639ba",
      brightCyan: "#0a7ea4",
      brightWhite: "#8c959f",
    },
    monaco: "github-light",
    chrome: {
      background: "#ffffff",
      panel: "#f6f8fa",
      panelAlt: "#eaeef2",
      border: "#d1d9e0",
      foreground: "#1f2328",
      dim: "#59636e",
      accent: "#0969da",
    },
  },
  "sharp-dark": {
    id: "sharp-dark",
    label: "Sharp Dark",
    xterm: {
      background: "#0a0e14",
      foreground: "#d3e0f2",
      cursor: "#6cb6ff",
      selectionBackground: "#1b3a5f",
      black: "#3b4252",
      red: "#ff6b6b",
      green: "#7ee787",
      yellow: "#f2cc60",
      blue: "#6cb6ff",
      magenta: "#d2a8ff",
      cyan: "#76dbd9",
      white: "#c8d3e0",
      brightBlack: "#5c6773",
      brightRed: "#ffa198",
      brightGreen: "#a4f2b8",
      brightYellow: "#ffe08a",
      brightBlue: "#a8d3ff",
      brightMagenta: "#e2c5ff",
      brightCyan: "#a0f0ee",
      brightWhite: "#f0f6fc",
    },
    monaco: "sharp-dark",
    chrome: {
      background: "#0a0e14",
      panel: "#10151d",
      panelAlt: "#161d28",
      // Signature of this theme: crisp, high-contrast light-blue outlines.
      border: "#6cb6ff",
      foreground: "#d3e0f2",
      dim: "#7a8699",
      accent: "#2f81f7",
    },
  },
};

export const DEFAULT_THEME_ID = "tokyo-night";

export function getTheme(id: string): AppTheme {
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
}
