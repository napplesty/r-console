/**
 * Rule-based keyword highlighting for terminal output (MobaXterm-style).
 *
 * This module is the pure matching engine: it takes one line of text plus a
 * list of rules and returns the match spans. It is deliberately free of
 * xterm imports so it is trivially unit-testable; the xterm decoration
 * plumbing lives in components/Terminal.tsx.
 */

/** A rule's colors are either a #RRGGBB value or a named severity that is
 *  resolved against the active theme at render time. */
export type HighlightSeverity =
  | "error"
  | "warn"
  | "success"
  | "info"
  | "accent"
  | "dim";

export interface HighlightRule {
  /** Regular expression source (without slashes). */
  pattern: string;
  /** Regex flags; the "g" flag is always implied. */
  flags?: string;
  /** #RRGGBB color or a named severity. */
  foreground?: string;
  background?: string;
}

/** One match on a line; columns are 0-based, endCol exclusive. */
export interface HighlightSpan {
  startCol: number;
  endCol: number;
  foreground?: string;
  background?: string;
}

/** Concrete colors for the named severities, derived from the active theme. */
export interface HighlightPalette {
  error: string;
  warn: string;
  success: string;
  info: string;
  accent: string;
  dim: string;
}

const SEVERITIES: HighlightSeverity[] = [
  "error",
  "warn",
  "success",
  "info",
  "accent",
  "dim",
];

/** Resolve a rule color to a concrete #RRGGBB value for xterm decorations. */
export function resolveHighlightColor(
  value: string | undefined,
  palette: HighlightPalette,
): string | undefined {
  if (!value) return undefined;
  if ((SEVERITIES as string[]).includes(value)) {
    return palette[value as HighlightSeverity];
  }
  return value;
}

/**
 * Match all rules against one line. Deterministic precedence: the first
 * rule wins — a span that overlaps an already-accepted span is dropped, so
 * rule order in the settings defines priority. Rules run per line, so a
 * long line is bounded work; invalid regex rules are skipped gracefully.
 */
export function matchLine(line: string, rules: HighlightRule[]): HighlightSpan[] {
  if (!line) return [];
  const spans: HighlightSpan[] = [];
  for (const rule of rules) {
    let re: RegExp;
    try {
      const flags = rule.flags ?? "";
      re = new RegExp(rule.pattern, flags.includes("g") ? flags : flags + "g");
    } catch {
      continue; // invalid pattern or flags: skip this rule
    }
    for (const m of line.matchAll(re)) {
      const text = m[0];
      if (text.length === 0) continue; // ignore zero-width matches
      const startCol = m.index;
      const endCol = startCol + text.length;
      if (spans.some((s) => startCol < s.endCol && endCol > s.startCol)) {
        continue; // overlaps an earlier (higher-priority) match
      }
      spans.push({
        startCol,
        endCol,
        foreground: rule.foreground,
        background: rule.background,
      });
    }
  }
  return spans.sort((a, b) => a.startCol - b.startCol);
}

/**
 * Default rule set (all case-insensitive); rule order is the match
 * priority — the first matching rule wins. The user can replace the set
 * wholesale via the settings (persisted in localStorage alongside the
 * other toggles).
 */
export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  {
    pattern: "\\b(?:error|fatal|fail|failed|failure|exception|panic)\\b",
    flags: "i",
    foreground: "error",
  },
  {
    pattern: "\\b(?:warn|warning|deprecated)\\b",
    flags: "i",
    foreground: "warn",
  },
  {
    pattern: "\\b(?:success|succeeded|ok|done|passed)\\b",
    flags: "i",
    foreground: "success",
  },
  {
    pattern: "\\b(?:info|notice)\\b",
    flags: "i",
    foreground: "info",
  },
  {
    // ISO 8601 timestamps; before IPv6 so "10:20:30" inside a timestamp is
    // not claimed by the IPv6 rule first.
    pattern:
      "\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?",
    foreground: "dim",
  },
  {
    // URLs run to the next whitespace.
    pattern: "https?://\\S+",
    flags: "i",
    foreground: "accent",
  },
  {
    // IPv4
    pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b",
    foreground: "accent",
  },
  {
    // IPv6, including ::-compressed forms
    pattern: "\\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\\b",
    foreground: "accent",
  },
];
