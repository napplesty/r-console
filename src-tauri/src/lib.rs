mod config;
mod credentials;
mod local_pty;
mod paths;
mod runtime;
mod session;
mod ssh;
mod ssh_config;
mod sysmon;
mod workspace;

use session::SharedSessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Start the interactive (single-thread) and transfer (thread-pool)
    // runtimes before any session work; Tauri's own runtime drives the UI.
    runtime::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Move legacy app-config-dir state into ~/.r-console (once).
            paths::migrate_legacy_config(app.handle());
            Ok(())
        })
        .manage(SharedSessionManager::default())
        .invoke_handler(tauri::generate_handler![
            session::session_spawn_local,
            session::session_spawn_ssh,
            session::session_write,
            session::session_resize,
            session::session_close,
            session::sftp_list_dir,
            session::sftp_download,
            session::sftp_upload,
            session::sftp_read_text,
            session::sftp_write_text,
            session::tmux_control_send,
            sysmon::sys_stats,
            config::saved_sessions_list,
            config::saved_sessions_save,
            config::saved_sessions_delete,
            ssh_config::ssh_config_hosts,
            ssh::host_key_decision,
            sysmon::sys_stats,
            sysmon::ssh_ping,
            credentials::vault_status,
            credentials::vault_unlock,
            credentials::vault_lock,
            credentials::credential_set,
            credentials::credential_get,
            credentials::credential_delete,
            workspace::workspace_save,
            workspace::workspace_load,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
