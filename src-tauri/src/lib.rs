mod config;
mod credentials;
mod git;
mod local_pty;
mod localfs;
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
            session::sftp_rename,
            session::sftp_delete,
            session::sftp_mkdir,
            session::ssh_grep,
            session::tmux_control_send,
            localfs::localfs_list_dir,
            localfs::localfs_read_text,
            localfs::localfs_write_text,
            localfs::localfs_rename,
            localfs::localfs_mkdir,
            localfs::localfs_delete,
            localfs::localfs_grep,
            localfs::localfs_copy,
            sysmon::sys_stats,
            config::saved_sessions_list,
            config::saved_sessions_save,
            config::saved_sessions_delete,
            ssh_config::ssh_config_hosts,
            ssh::host_key_decision,
            sysmon::sys_stats,
            sysmon::ssh_ping,
            git::git_status,
            git::git_diff,
            git::git_file_content,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
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
