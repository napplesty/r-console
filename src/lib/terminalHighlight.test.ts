import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIGHLIGHT_RULES,
  matchLine,
  resolveHighlightColor,
  type HighlightRule,
} from "./terminalHighlight";

const errorRule: HighlightRule = {
  pattern: "\\bERROR\\b",
  foreground: "error",
};
const warnRule: HighlightRule = { pattern: "\\bWARN\\b", foreground: "warn" };

describe("matchLine", () => {
  it("applies multiple rules on one line", () => {
    const line = "2024 WARN disk full, ERROR ignored";
    const spans = matchLine(line, [errorRule, warnRule]);
    expect(spans).toEqual([
      { startCol: 5, endCol: 9, foreground: "warn", background: undefined },
      { startCol: 21, endCol: 26, foreground: "error", background: undefined },
    ]);
  });

  it("resolves overlaps deterministically: the first rule wins", () => {
    const line = "ERROR happened";
    const spans = matchLine(line, [
      { pattern: "ERROR", foreground: "error" },
      { pattern: "OR ha", foreground: "warn" }, // overlaps the first match
    ]);
    expect(spans).toEqual([
      { startCol: 0, endCol: 5, foreground: "error", background: undefined },
    ]);
  });

  it("prefers the earlier rule even when it matches later in the line", () => {
    const line = "WARN then ERROR";
    const spans = matchLine(line, [errorRule, warnRule]);
    expect(spans).toEqual([
      { startCol: 0, endCol: 4, foreground: "warn", background: undefined },
      { startCol: 10, endCol: 15, foreground: "error", background: undefined },
    ]);
  });

  it("supports capture-free patterns and flags", () => {
    const line = "error error ERROR";
    const spans = matchLine(line, [{ pattern: "error", flags: "i", foreground: "error" }]);
    expect(spans.map((s) => [s.startCol, s.endCol])).toEqual([
      [0, 5],
      [6, 11],
      [12, 17],
    ]);
  });

  it("skips invalid regex rules gracefully and still applies valid ones", () => {
    const line = "plain ERROR line";
    const spans = matchLine(line, [
      { pattern: "(unclosed", foreground: "warn" }, // invalid regex
      { pattern: "x", flags: "z" }, // invalid flags
      errorRule,
    ]);
    expect(spans).toEqual([
      { startCol: 6, endCol: 11, foreground: "error", background: undefined },
    ]);
  });

  it("returns no spans for an empty line", () => {
    expect(matchLine("", [errorRule])).toEqual([]);
    expect(matchLine("", [])).toEqual([]);
  });

  it("ignores zero-width matches without hanging", () => {
    const spans = matchLine("abc", [{ pattern: "x*", foreground: "warn" }]);
    expect(spans).toEqual([]);
  });

  it("handles very long lines without catastrophic behavior", () => {
    const line = `${"x".repeat(200_000)} ERROR ${"y".repeat(200_000)}`;
    const start = performance.now();
    const spans = matchLine(line, [errorRule, warnRule, ...DEFAULT_HIGHLIGHT_RULES]);
    expect(spans).toEqual([
      {
        startCol: 200_001,
        endCol: 200_006,
        foreground: "error",
        background: undefined,
      },
    ]);
    // Generous bound: the per-line scan must stay linear-ish.
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("matches the default rule set", () => {
    const line = "2024-05-01T10:20:30Z ERROR from 10.0.0.1 and fe80::1 WARN";
    const spans = matchLine(line, DEFAULT_HIGHLIGHT_RULES);
    const bySeverity = (fg: string) =>
      spans.some(
        (s) => s.foreground === fg && line.slice(s.startCol, s.endCol).length > 0,
      );
    expect(bySeverity("dim")).toBe(true);
    expect(bySeverity("error")).toBe(true);
    expect(bySeverity("accent")).toBe(true);
    expect(bySeverity("warn")).toBe(true);
    expect(line.slice(spans[0].startCol, spans[0].endCol)).toBe(
      "2024-05-01T10:20:30Z",
    );
  });

  it("default rules are case-insensitive", () => {
    const spans = matchLine("Error occurred, then Warn", DEFAULT_HIGHLIGHT_RULES);
    expect(spans.map((s) => s.foreground)).toEqual(["error", "warn"]);
  });

  it("severity words require word boundaries", () => {
    // "terror"/"warm" must not hit the error/warn rules.
    expect(matchLine("terror warm okie", DEFAULT_HIGHLIGHT_RULES)).toEqual([]);
    const spans = matchLine("panic! all ok now", DEFAULT_HIGHLIGHT_RULES);
    expect(spans.map((s) => s.foreground)).toEqual(["error", "success"]);
  });

  it("matches success and info levels", () => {
    const spans = matchLine(
      "build SUCCEEDED, tests passed, notice: done",
      DEFAULT_HIGHLIGHT_RULES,
    );
    expect(spans.map((s) => s.foreground)).toEqual([
      "success",
      "success",
      "info",
      "success",
    ]);
  });

  it("captures URLs up to whitespace", () => {
    const line = "see https://example.com/a?b=1 and http://10.0.0.1:8080/x next";
    const spans = matchLine(line, DEFAULT_HIGHLIGHT_RULES);
    const urls = spans
      .filter((s) => s.foreground === "accent")
      .map((s) => line.slice(s.startCol, s.endCol));
    // The URL rule claims the whole URL, including the IPv4 inside it.
    expect(urls).toEqual([
      "https://example.com/a?b=1",
      "http://10.0.0.1:8080/x",
    ]);
  });
});

describe("resolveHighlightColor", () => {
  const palette = {
    error: "#ff0000",
    warn: "#ffff00",
    success: "#00ff00",
    info: "#00ffff",
    accent: "#0000ff",
    dim: "#888888",
  };

  it("maps named severities to palette colors", () => {
    expect(resolveHighlightColor("error", palette)).toBe("#ff0000");
    expect(resolveHighlightColor("success", palette)).toBe("#00ff00");
    expect(resolveHighlightColor("info", palette)).toBe("#00ffff");
    expect(resolveHighlightColor("dim", palette)).toBe("#888888");
  });

  it("passes concrete colors through", () => {
    expect(resolveHighlightColor("#123456", palette)).toBe("#123456");
    expect(resolveHighlightColor(undefined, palette)).toBeUndefined();
  });
});
