export type TabKind = "local" | "ssh";

/** Split layout of a tab: horizontal = side-by-side columns, vertical = stacked rows. */
export type SplitDirection = "horizontal" | "vertical";

/**
 * Connection health of an SSH pane. Undefined means "live" (the common
 * case). "reconnecting" shows an overlay while auto-reconnect runs; "dead"
 * means the user cancelled or credentials are missing — manual retry only.
 */
export type PaneStatus = "live" | "reconnecting" | "dead";

export interface Pane {
  id: string;
  sessionId: string;
  kind: TabKind;
  /** Present for SSH panes; links the pane to its connection (used by SFTP). */
  connKey?: string;
  title: string;
  /** In-memory only (never persisted): enables splitting SSH panes without
   *  re-prompting for credentials. */
  connectConfig?: SshConnectConfig;
  /** Connection health; undefined behaves as "live". */
  status?: PaneStatus;
  /** The saved/configured session this pane came from (or a pseudo entry
   *  with id "" for ad-hoc connections). Drives workspace restore. */
  saved?: SavedSession | null;
  /** tmux session name for persistent panes; reused across reconnects. */
  tmuxSession?: string;
}

export interface Tab {
  id: string;
  title: string;
  panes: Pane[];
  direction: SplitDirection;
  /** MultiExec: mirror the active pane's input to all panes of the tab. */
  broadcast: boolean;
  activePaneId: string;
}

export type SshAuth =
  | { kind: "password"; password: string }
  | { kind: "key"; keyPath: string; passphrase?: string };

export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** Run inside a persistent tmux session (survives disconnects/restarts). */
  persistent: boolean;
  /** tmux session name, generated once per pane and reused on reconnect. */
  tmuxSession?: string;
}

export interface SshSessionInfo {
  sessionId: string;
  connKey: string;
}

export interface SavedSession {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** "password" | "key" */
  authKind: string;
  keyPath?: string | null;
  /** Run inside a persistent tmux session. */
  persistent: boolean;
}

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number | null;
}

export interface SftpDirListing {
  path: string;
  entries: SftpEntry[];
}

/** Progress of one SFTP transfer, emitted by the `sftp-progress` event. */
export interface SftpProgress {
  transferId: string;
  fileName: string;
  direction: "download" | "upload";
  done: number;
  /** 0 signals a failed transfer. */
  total: number;
}

/** One changed file parsed from `git status --porcelain=v2`. */
export interface GitStatusEntry {
  path: string;
  /** Original path for renamed/copied entries. */
  origPath?: string | null;
  /** Index (staged) status letter ("M"/"A"/"D"/"R"/"C"/"U"), "." = unchanged,
   *  "?" = untracked. */
  stagedState: string;
  /** Worktree (unstaged) status letter, "." = unchanged. */
  unstagedState: string;
}

/** Repo status returned by the `git_status` command. */
export interface GitStatus {
  /** False when the working directory is not inside a git repository. */
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

/** Remote system stats returned by the `sys_stats` command. */export interface SysStats {
  cpuPercent: number;
  memUsedKb: number;
  memTotalKb: number;
  diskUsedKb: number;
  diskTotalKb: number;
  loadAvg: [number, number, number];
}

/** One concrete host entry parsed from ~/.ssh/config. */
export interface SshConfigHost {
  alias: string;
  hostName: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
}
