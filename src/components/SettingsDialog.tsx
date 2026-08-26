import { useEffect, useState } from "react";
import MdiIcon from "@mdi/react";
import {
  mdiCogOutline,
  mdiConsole,
  mdiInformationOutline,
  mdiRefresh,
  mdiTrashCanOutline,
} from "@mdi/js";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore, type CursorStyle } from "../state/store";
import { THEMES } from "../lib/themes";
import {
  DEFAULT_HIGHLIGHT_RULES,
  type HighlightRule,
  type HighlightSeverity,
} from "../lib/terminalHighlight";
import { checkForUpdates } from "../lib/updater";
import Modal from "./ui/Modal";
import Toggle from "./ui/Toggle";

type Section = "appearance" | "terminal" | "about";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: mdiCogOutline },
  { id: "terminal", label: "Terminal", icon: mdiConsole },
  { id: "about", label: "About", icon: mdiInformationOutline },
];

const SEVERITIES: HighlightSeverity[] = [
  "error",
  "warn",
  "success",
  "info",
  "accent",
  "dim",
];

/** True when the rule's pattern compiles as a regex. */
function isValidPattern(rule: HighlightRule): boolean {
  try {
    new RegExp(rule.pattern, rule.flags ?? "");
    return true;
  } catch {
    return false;
  }
}

const labelClass = "flex items-center justify-between gap-3 py-2";
const labelTextClass = "min-w-0 text-sm text-(--text)";
const inputClass =
  "w-24 rounded border border-(--border) bg-transparent px-2 py-1 text-sm text-(--text) outline-none focus:border-(--accent)";

/** One highlight rule row: pattern, flags, foreground color, delete. */
function RuleRow({
  rule,
  index,
  onChange,
  onDelete,
}: {
  rule: HighlightRule;
  index: number;
  onChange: (rule: HighlightRule) => void;
  onDelete: () => void;
}) {
  const valid = isValidPattern(rule);
  const isCustomColor =
    !!rule.foreground && !SEVERITIES.includes(rule.foreground as HighlightSeverity);
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={rule.pattern}
        onChange={(e) => onChange({ ...rule, pattern: e.target.value })}
        placeholder="Regular expression"
        spellCheck={false}
        title={valid ? undefined : "Invalid regular expression"}
        className={`min-w-0 flex-1 rounded border bg-transparent px-2 py-1 font-mono text-xs text-(--text) outline-none ${
          valid
            ? "border-(--border) focus:border-(--accent)"
            : "border-red-500 focus:border-red-400"
        }`}
      />
      <input
        value={rule.flags ?? ""}
        onChange={(e) => onChange({ ...rule, flags: e.target.value })}
        placeholder="i"
        spellCheck={false}
        title="Regex flags (g is implied)"
        className="w-10 rounded border border-(--border) bg-transparent px-1.5 py-1 font-mono text-xs text-(--text) outline-none focus:border-(--accent)"
      />
      <select
        value={isCustomColor ? "custom" : (rule.foreground ?? "")}
        onChange={(e) => {
          const v = e.target.value;
          onChange({
            ...rule,
            foreground: v === "custom" ? "#ff0000" : v || undefined,
          });
        }}
        title="Match color (resolved against the theme unless a hex value is set)"
        className="w-24 shrink-0 rounded border border-(--border) bg-transparent px-1 py-1 text-xs text-(--text) outline-none focus:border-(--accent)"
      >
        <option value="" className="bg-(--panel-alt) text-(--text)">
          (none)
        </option>
        {SEVERITIES.map((s) => (
          <option key={s} value={s} className="bg-(--panel-alt) text-(--text)">
            {s}
          </option>
        ))}
        <option value="custom" className="bg-(--panel-alt) text-(--text)">
          custom…
        </option>
      </select>
      {isCustomColor && (
        <input
          value={rule.foreground ?? ""}
          onChange={(e) => onChange({ ...rule, foreground: e.target.value })}
          placeholder="#RRGGBB"
          spellCheck={false}
          title="Custom foreground color"
          className="w-20 rounded border border-(--border) bg-transparent px-1.5 py-1 font-mono text-xs text-(--text) outline-none focus:border-(--accent)"
        />
      )}
      <button
        onClick={onDelete}
        title={`Delete rule ${index + 1}`}
        className="shrink-0 rounded p-1 text-(--text-dim) hover:bg-(--hover-strong) hover:text-(--text)"
      >
        <MdiIcon path={mdiTrashCanOutline} size="14px" />
      </button>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Cmd/Ctrl+K", "Command palette"],
  ["Cmd/Ctrl+,", "Open settings"],
  ["Cmd/Ctrl+T", "New local terminal"],
  ["Cmd/Ctrl+W", "Close tab"],
  ["Cmd/Ctrl+D", "Split right"],
  ["Shift+Cmd/Ctrl+D", "Split down"],
  ["Cmd/Ctrl+G", "Toggle Git panel"],
  ["Shift+Cmd/Ctrl+Enter", "Broadcast input to all panes"],
  ["Cmd/Ctrl+Up / Down", "Jump to previous / next command"],
  ["Shift+Cmd/Ctrl+C / V", "Copy selection / paste"],
  ["Shift+Drag", "Force text selection while the app captures the mouse"],
  ["Shift+Wheel", "Bypass tmux scroll capture"],
];

/** Settings dialog (Cmd/Ctrl+,): appearance, terminal behavior, about. */
export default function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const themeId = useAppStore((s) => s.themeId);
  const setThemeId = useAppStore((s) => s.setThemeId);
  const fontSize = useAppStore((s) => s.fontSize);
  const setFontSize = useAppStore((s) => s.setFontSize);
  const cursorStyle = useAppStore((s) => s.cursorStyle);
  const setCursorStyle = useAppStore((s) => s.setCursorStyle);
  const cursorBlink = useAppStore((s) => s.cursorBlink);
  const setCursorBlink = useAppStore((s) => s.setCursorBlink);
  const imeCompat = useAppStore((s) => s.imeCompat);
  const setImeCompat = useAppStore((s) => s.setImeCompat);
  const fpsOverlay = useAppStore((s) => s.fpsOverlay);
  const setFpsOverlay = useAppStore((s) => s.setFpsOverlay);
  const scrollback = useAppStore((s) => s.scrollback);
  const setScrollback = useAppStore((s) => s.setScrollback);
  const followCwd = useAppStore((s) => s.followCwd);
  const setFollowCwd = useAppStore((s) => s.setFollowCwd);
  const highlightEnabled = useAppStore((s) => s.highlightEnabled);
  const setHighlightEnabled = useAppStore((s) => s.setHighlightEnabled);
  const highlightRules = useAppStore((s) => s.highlightRules);
  const setHighlightRules = useAppStore((s) => s.setHighlightRules);

  const [section, setSection] = useState<Section>("appearance");
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open) setVersion("");
  }, [open]);

  // Lazily resolved: getVersion() only works inside the Tauri webview.
  useEffect(() => {
    if (!open || version) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("dev"));
  }, [open, version]);

  if (!open) return null;

  const updateRule = (i: number, rule: HighlightRule) =>
    setHighlightRules(highlightRules.map((r, j) => (j === i ? rule : r)));

  const navItemClass = (active: boolean) =>
    `flex w-full items-center gap-2.5 rounded px-3 py-1.5 text-left text-sm ${
      active
        ? "bg-white/10 text-(--text)"
        : "text-(--text-dim) hover:bg-(--hover) hover:text-(--text)"
    }`;

  return (
    <Modal
      onClose={() => setOpen(false)}
      className="h-[32rem] w-[54rem] max-w-[90vw] flex-row"
    >
      {/* Left navigation */}
      <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-(--border) p-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={navItemClass(section === s.id)}
          >
            <MdiIcon path={s.icon} size="16px" className="shrink-0" />
            {s.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {section === "appearance" && (
            <>
              <h2 className="mb-3 text-sm font-semibold text-(--text)">Theme</h2>
              <div className="mb-6 grid grid-cols-2 gap-2 2xl:grid-cols-3">
                {Object.values(THEMES).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setThemeId(t.id)}
                    title={t.label}
                    className={`rounded border p-2.5 text-left transition-colors ${
                      themeId === t.id
                        ? "border-(--accent)"
                        : "border-(--border) hover:border-(--text-dim)"
                    }`}
                  >
                    <div className="mb-1.5 flex items-center gap-1">
                      {[t.chrome.background, t.chrome.panel, t.chrome.accent].map(
                        (c, i) => (
                          <span
                            key={i}
                            className="h-4 w-4 rounded-sm border border-black/20"
                            style={{ background: c }}
                          />
                        ),
                      )}
                      <span
                        className="h-4 w-4 rounded-sm border border-black/20"
                        style={{ background: t.chrome.foreground }}
                      />
                    </div>
                    <span className="text-xs text-(--text)">{t.label}</span>
                  </button>
                ))}
              </div>

              <h2 className="mb-1 text-sm font-semibold text-(--text)">Font & cursor</h2>
              <div className="divide-y divide-(--border)">
                <div className={labelClass}>
                  <span className={labelTextClass}>Font size</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setFontSize(fontSize - 1)}
                      className="rounded border border-(--border) px-2 py-0.5 text-sm text-(--text) hover:border-(--accent)"
                      title="Decrease font size"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={8}
                      max={32}
                      value={fontSize}
                      onChange={(e) => setFontSize(Number(e.target.value))}
                      className={`${inputClass} w-16 text-center`}
                    />
                    <button
                      onClick={() => setFontSize(fontSize + 1)}
                      className="rounded border border-(--border) px-2 py-0.5 text-sm text-(--text) hover:border-(--accent)"
                      title="Increase font size"
                    >
                      +
                    </button>
                    <span className="w-6 text-xs text-(--text-dim)">px</span>
                  </div>
                </div>
                <div className={labelClass}>
                  <span className={labelTextClass}>Cursor style</span>
                  <select
                    value={cursorStyle}
                    onChange={(e) => setCursorStyle(e.target.value as CursorStyle)}
                    className="w-28 rounded border border-(--border) bg-transparent px-2 py-1 text-sm text-(--text) outline-none focus:border-(--accent)"
                  >
                    <option value="block" className="bg-(--panel-alt) text-(--text)">
                      Block
                    </option>
                    <option value="underline" className="bg-(--panel-alt) text-(--text)">
                      Underline
                    </option>
                    <option value="bar" className="bg-(--panel-alt) text-(--text)">
                      Bar
                    </option>
                  </select>
                </div>
                <div className={labelClass}>
                  <span className={labelTextClass}>Cursor blink</span>
                  <Toggle checked={cursorBlink} onChange={setCursorBlink} />
                </div>
              </div>
            </>
          )}

          {section === "terminal" && (
            <>
              <h2 className="mb-1 text-sm font-semibold text-(--text)">Behavior</h2>
              <div className="mb-6 divide-y divide-(--border)">
                <div className={labelClass}>
                  <span className={labelTextClass}>Scrollback lines</span>
                  <input
                    type="number"
                    min={100}
                    step={1000}
                    value={scrollback}
                    onChange={(e) => setScrollback(Number(e.target.value))}
                    title="Applies to terminals opened afterwards"
                    className={inputClass}
                  />
                </div>
                <div className={labelClass}>
                  <span className="flex min-w-0 flex-col">
                    <span className={labelTextClass}>Follow working directory</span>
                    <span className="text-xs text-(--text-dim)">
                      The file panel follows the terminal's cwd (OSC 7)
                    </span>
                  </span>
                  <Toggle checked={followCwd} onChange={setFollowCwd} />
                </div>
                <div className={labelClass}>
                  <span className="flex min-w-0 flex-col">
                    <span className={labelTextClass}>
                      Keyword highlighting
                    </span>
                    <span className="text-xs text-(--text-dim)">
                      Decorate matches (errors, warnings, IPs) in terminal
                      output
                    </span>
                  </span>
                  <Toggle
                    checked={highlightEnabled}
                    onChange={setHighlightEnabled}
                  />
                </div>
                <div className={labelClass}>
                  <span className="flex min-w-0 flex-col">
                    <span className={labelTextClass}>IME compatibility</span>
                    <span className="text-xs text-(--text-dim)">
                      Turn on if the input method fails to compose (symbols,
                      CJK) in some apps — keeps the text input visible with a
                      real caret. Costs some render overhead.
                    </span>
                  </span>
                  <Toggle checked={imeCompat} onChange={setImeCompat} />
                </div>
                <div className={labelClass}>
                  <span className="flex min-w-0 flex-col">
                    <span className={labelTextClass}>FPS overlay</span>
                    <span className="text-xs text-(--text-dim)">
                      Show a live frame-rate counter (diagnostics; green ≥55)
                    </span>
                  </span>
                  <Toggle checked={fpsOverlay} onChange={setFpsOverlay} />
                </div>
              </div>

              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-(--text)">Highlight rules</h2>
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      setHighlightRules([...highlightRules, { pattern: "" }])
                    }
                    className="rounded border border-(--border) px-2 py-1 text-xs text-(--text) hover:border-(--accent)"
                  >
                    Add rule
                  </button>
                  <button
                    onClick={() => setHighlightRules(DEFAULT_HIGHLIGHT_RULES)}
                    title="Restore the built-in rule set"
                    className="flex items-center gap-1 rounded border border-(--border) px-2 py-1 text-xs text-(--text) hover:border-(--accent)"
                  >
                    <MdiIcon path={mdiRefresh} size="12px" />
                    Reset
                  </button>
                </div>
              </div>
              <p className="mb-2 text-xs text-(--text-dim)">
                Rules match top-down; the first match wins and overlapping
                matches are skipped.
              </p>
              <div className="flex flex-col gap-1.5">
                {highlightRules.map((rule, i) => (
                  <RuleRow
                    key={i}
                    rule={rule}
                    index={i}
                    onChange={(r) => updateRule(i, r)}
                    onDelete={() =>
                      setHighlightRules(highlightRules.filter((_, j) => j !== i))
                    }
                  />
                ))}
              </div>
            </>
          )}

          {section === "about" && (
            <>
              <h2 className="mb-1 text-sm font-semibold text-(--text)">
                R Console
              </h2>
              <p className="mb-4 text-xs text-(--text-dim)">
                Version {version || "…"}
              </p>
              <button
                onClick={() => {
                  setChecking(true);
                  void checkForUpdates(false).finally(() => setChecking(false));
                }}
                disabled={checking}
                className="mb-6 rounded bg-(--accent) px-3 py-1.5 text-xs text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)] disabled:opacity-50"
              >
                {checking ? "Checking…" : "Check for updates"}
              </button>

              <h2 className="mb-2 text-sm font-semibold text-(--text)">
                Keyboard shortcuts
              </h2>
              <div className="flex flex-col gap-1">
                {SHORTCUTS.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center justify-between">
                    <span className="text-sm text-(--text-dim)">{desc}</span>
                    <kbd className="rounded border border-(--border) bg-(--panel-alt) px-2 py-0.5 font-mono text-xs text-(--text)">
                      {keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </>
          )}
      </div>
    </Modal>
  );
}
