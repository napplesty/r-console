//! Remote system monitoring: collects CPU / memory / disk / load stats from
//! a Linux server's /proc filesystem over a single SSH exec channel.

use crate::session::{get_conn, SharedSessionManager};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysStats {
    pub cpu_percent: f64,
    pub mem_used_kb: u64,
    pub mem_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_total_kb: u64,
    pub load_avg: [f64; 3],
}

/// Prints machine-parseable `KEY value...` lines on stdout. CPU usage is
/// computed from two /proc/stat reads 0.2s apart. Linux-only: the command
/// fails on other systems and the frontend hides the monitor.
const STATS_SCRIPT: &str = r#"
read _ u n s i w q t st _ < /proc/stat
idle1=$i
total1=$((u+n+s+i+w+q+t+st))
sleep 0.2
read _ u n s i w q t st _ < /proc/stat
dt=$(( (u+n+s+i+w+q+t+st) - total1 ))
di=$((i - idle1))
awk -v dt="$dt" -v di="$di" 'BEGIN { printf "CPU %.1f\n", (dt > 0) ? 100.0 * (dt - di) / dt : 0.0 }'
awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { print "MEM " t " " a }' /proc/meminfo
df -kP / | awk 'NR == 2 { print "DISK " $3 " " $2 }'
awk '{ print "LOAD " $1 " " $2 " " $3 }' /proc/loadavg
"#;

#[tauri::command]
pub async fn sys_stats(
    state: State<'_, SharedSessionManager>,
    conn_key: String,
) -> Result<SysStats, String> {
    let conn = get_conn(&state, &conn_key)?;
    let out = conn.exec(STATS_SCRIPT).await?;
    parse_stats(&out)
}

/// Round-trip latency of the connection, measured with a protocol-level
/// keepalive ping (a single RTT, no channel or remote shell setup).
#[tauri::command]
pub async fn ssh_ping(
    state: State<'_, SharedSessionManager>,
    conn_key: String,
) -> Result<u64, String> {
    let conn = get_conn(&state, &conn_key)?;
    conn.ping().await
}

fn parse_stats(out: &str) -> Result<SysStats, String> {
    let mut cpu = None;
    let mut mem = None;
    let mut disk = None;
    let mut load = None;
    for line in out.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.first().copied() {
            Some("CPU") if parts.len() == 2 => {
                cpu = parts[1].parse::<f64>().ok();
            }
            Some("MEM") if parts.len() == 3 => {
                mem = parts[1]
                    .parse::<u64>()
                    .ok()
                    .zip(parts[2].parse::<u64>().ok());
            }
            Some("DISK") if parts.len() == 3 => {
                disk = parts[1]
                    .parse::<u64>()
                    .ok()
                    .zip(parts[2].parse::<u64>().ok());
            }
            Some("LOAD") if parts.len() == 4 => {
                let p = |i: usize| parts[i].parse::<f64>().ok();
                load = p(1).zip(p(2)).zip(p(3)).map(|((a, b), c)| [a, b, c]);
            }
            _ => {}
        }
    }
    match (cpu, mem, disk, load) {
        (
            Some(cpu_percent),
            Some((mem_total_kb, mem_available_kb)),
            Some((disk_used_kb, disk_total_kb)),
            Some(load_avg),
        ) => Ok(SysStats {
            cpu_percent,
            mem_used_kb: mem_total_kb.saturating_sub(mem_available_kb),
            mem_total_kb,
            disk_used_kb,
            disk_total_kb,
            load_avg,
        }),
        _ => Err(format!("Unparseable stats output: {out:?}")),
    }
}
