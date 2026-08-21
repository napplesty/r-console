//! Reads the user's OpenSSH client config (~/.ssh/config) and exposes the
//! declared hosts, so existing setups work without re-entering them.

use serde::Serialize;
use ssh2_config::{ParseRule, SshConfig};
use std::fs::File;
use std::io::BufReader;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    /// Host alias as written in the config file.
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

#[tauri::command]
pub fn ssh_config_hosts(app: AppHandle) -> Result<Vec<SshConfigHost>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("Failed to locate home directory: {e}"))?;
    let path = home.join(".ssh").join("config");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file =
        File::open(&path).map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    let config = SshConfig::default()
        .parse(&mut reader, ParseRule::ALLOW_UNKNOWN_FIELDS)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let mut hosts = Vec::new();
    for host in config.get_hosts() {
        for clause in &host.pattern {
            let alias = &clause.pattern;
            // Skip negated clauses and wildcard patterns: not concrete hosts.
            if clause.negated || alias.contains(['*', '?', '!']) {
                continue;
            }
            let params = config.query(alias);
            hosts.push(SshConfigHost {
                alias: alias.clone(),
                host_name: params.host_name.unwrap_or_else(|| alias.clone()),
                user: params.user,
                port: params.port,
                identity_file: params
                    .identity_file
                    .and_then(|v| v.first().map(|p| p.to_string_lossy().into_owned())),
            });
        }
    }
    hosts.sort_by(|a, b| a.alias.cmp(&b.alias));
    hosts.dedup_by(|a, b| a.alias == b.alias);
    Ok(hosts)
}
