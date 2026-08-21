import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import MdiIcon from "@mdi/react";
import { mdiCircle, mdiDownload, mdiUpload } from "@mdi/js";
import { activePane, useAppStore } from "../state/store";
import type { SftpProgress, SysStats } from "../lib/types";

function formatGb(kb: number): string {
  return (kb / 1024 / 1024).toFixed(1);
}

function percent(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

/** Compact usage meter: a thin fill bar plus the existing text. */
function Meter({
  label,
  value,
  text,
}: {
  label: string;
  value: number;
  text: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const fill =
    pct < 60 ? "bg-(--accent)" : pct < 85 ? "bg-amber-400" : "bg-red-400";
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="h-1 w-10 overflow-hidden rounded bg-white/10">
        <span
          className={`block h-full rounded transition-all duration-500 ${fill}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span>{text}</span>
    </span>
  );
}

/** Bottom status bar: active session info, SFTP transfer progress, and
 *  remote system stats for the active SSH tab. */
export default function StatusBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const pane = activeTab ? activePane(activeTab) : undefined;

  const [transfers, setTransfers] = useState<Record<string, SftpProgress>>({});
  const [stats, setStats] = useState<SysStats | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  // Track SFTP transfer progress events, keyed by transferId.
  useEffect(() => {
    const unlisten = listen<SftpProgress>("sftp-progress", (event) => {
      const p = event.payload;
      setTransfers((prev) => ({ ...prev, [p.transferId]: p }));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Drop entries shortly after they complete, fail (total === 0), or error.
  useEffect(() => {
    const timers = Object.values(transfers)
      .filter((p) => p.total === 0 || p.done >= p.total)
      .map((p) =>
        window.setTimeout(() => {
          setTransfers((prev) => {
            const next = { ...prev };
            delete next[p.transferId];
            return next;
          });
        }, 2000),
      );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [transfers]);

  // Poll remote system stats for the active SSH pane only.
  const connKey = pane?.kind === "ssh" ? pane.connKey : undefined;
  const inFlight = useRef(false);
  useEffect(() => {
    setStats(null);
    if (!connKey) return;
    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        setStats(await invoke<SysStats>("sys_stats", { connKey }));
      } catch {
        setStats(null);
      } finally {
        inFlight.current = false;
      }
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => window.clearInterval(timer);
  }, [connKey]);

  // Poll the SSH round-trip latency for the active SSH pane only.
  const pingInFlight = useRef(false);
  useEffect(() => {
    setLatency(null);
    if (!connKey) return;
    const poll = async () => {
      if (pingInFlight.current) return;
      pingInFlight.current = true;
      try {
        setLatency(await invoke<number>("ssh_ping", { connKey }));
      } catch {
        setLatency(null);
      } finally {
        pingInFlight.current = false;
      }
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => window.clearInterval(timer);
  }, [connKey]);

  const activeTransfers = Object.values(transfers);

  const latencyColor =
    latency === null
      ? ""
      : latency < 80
        ? "text-(--accent)"
        : latency < 200
          ? "text-amber-400"
          : "text-red-400";

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-(--border) bg-(--panel) px-3 text-xs text-(--text-dim)">
      <span className="min-w-0 shrink truncate" title={pane?.connKey}>
        {activeTab && pane
          ? `${activeTab.title} · ${pane.kind === "ssh" ? pane.connKey : "Local"}`
          : "No session"}
      </span>

      {connKey && latency !== null && (
        <span className={`flex shrink-0 items-center gap-1 ${latencyColor}`}>
          <MdiIcon path={mdiCircle} size="10px" className="animate-pulse" />
          {latency} ms
        </span>
      )}

      <span className="flex min-w-0 flex-1 items-center justify-center gap-4">
        {activeTransfers.map((p) => (
          <span key={p.transferId} className="flex items-center gap-1 truncate">
            {p.fileName}
            <MdiIcon
              path={p.direction === "download" ? mdiDownload : mdiUpload}
              size="12px"
              className="shrink-0"
            />{" "}
            {p.total === 0
              ? "failed"
              : `${Math.min(100, Math.round((p.done / p.total) * 100))}%`}
          </span>
        ))}
      </span>

      {connKey && stats && (
        <span className="flex shrink-0 items-center gap-3 text-(--text-dim)">
          <Meter
            label="CPU"
            value={stats.cpuPercent}
            text={`${stats.cpuPercent.toFixed(0)}%`}
          />
          <Meter
            label="MEM"
            value={percent(stats.memUsedKb, stats.memTotalKb)}
            text={`${formatGb(stats.memUsedKb)}/${formatGb(stats.memTotalKb)} GB`}
          />
          <Meter
            label="DISK"
            value={percent(stats.diskUsedKb, stats.diskTotalKb)}
            text={`${formatGb(stats.diskUsedKb)}/${formatGb(stats.diskTotalKb)} GB`}
          />
          <span>LA {stats.loadAvg.map((v) => v.toFixed(1)).join(" ")}</span>
        </span>
      )}
    </footer>
  );
}
