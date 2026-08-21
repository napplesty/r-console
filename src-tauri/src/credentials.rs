//! Master-password-encrypted credential vault (MobaXterm-style), fully
//! self-contained: no OS keychain dependency, identical behavior on every
//! platform, and the vault file can travel with the rest of the config.
//!
//! Design: one JSON file (`~/.r-console/credentials.vault`, see paths.rs)
//! holding an AES-256-GCM ciphertext of the `session_id -> password` map.
//! The key is derived from the master password with Argon2id and a
//! per-save random salt. The master password lives only in process memory
//! while unlocked.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit};
use argon2::Argon2;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use zeroize::Zeroizing;

const FILE_NAME: &str = "credentials.vault";

#[derive(Default)]
struct VaultState {
    master: Option<Zeroizing<String>>,
    data: HashMap<String, String>,
}

static VAULT: OnceLock<Mutex<VaultState>> = OnceLock::new();

fn vault() -> &'static Mutex<VaultState> {
    VAULT.get_or_init(|| Mutex::new(VaultState::default()))
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    v: u32,
    salt: String,
    nonce: String,
    data: String,
}

fn vault_path() -> Result<PathBuf, String> {
    Ok(crate::paths::data_dir()?.join(FILE_NAME))
}

fn derive_key(master: &str, salt: &[u8]) -> Result<Aes256Gcm, String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(master.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(Aes256Gcm::new_from_slice(&key).expect("32-byte key"))
}

fn load_from_disk(master: &str) -> Result<HashMap<String, String>, String> {
    let path = vault_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read vault: {e}"))?;
    let file: VaultFile =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse vault: {e}"))?;
    let salt = B64.decode(&file.salt).map_err(|e| e.to_string())?;
    let nonce = B64.decode(&file.nonce).map_err(|e| e.to_string())?;
    let ciphertext = B64.decode(&file.data).map_err(|e| e.to_string())?;
    let cipher = derive_key(master, &salt)?;
    let plaintext = cipher
        // TODO: migrate off the deprecated `from_slice` once hybrid_array
        // exposes a cleaner slice-to-Nonce path.
        .decrypt(
            #[allow(deprecated)]
            aes_gcm::Nonce::from_slice(&nonce),
            ciphertext.as_ref(),
        )
        .map_err(|_| "Incorrect master password or corrupted vault".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| format!("Failed to parse vault data: {e}"))
}

fn save_to_disk(master: &str, data: &HashMap<String, String>) -> Result<(), String> {
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut salt).map_err(|e| format!("RNG failed: {e}"))?;
    getrandom::fill(&mut nonce_bytes).map_err(|e| format!("RNG failed: {e}"))?;
    let nonce = aes_gcm::Nonce::from(nonce_bytes);
    let cipher = derive_key(master, &salt)?;
    let plaintext = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption failed: {e}"))?;
    let file = VaultFile {
        v: 1,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        data: B64.encode(ciphertext),
    };
    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(vault_path()?, text).map_err(|e| format!("Failed to write vault: {e}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// Vault file exists (master password has been set at some point).
    pub initialized: bool,
    /// Master password currently held in memory.
    pub unlocked: bool,
}

#[tauri::command]
pub fn vault_status() -> Result<VaultStatus, String> {
    let st = vault().lock().map_err(|e| e.to_string())?;
    Ok(VaultStatus {
        initialized: vault_path()?.exists(),
        unlocked: st.master.is_some(),
    })
}

/// Unlock the vault, creating it on first use. Fails with a clear error when
/// the master password does not match the existing vault.
#[tauri::command]
pub fn vault_unlock(master_password: String) -> Result<(), String> {
    let data = load_from_disk(&master_password)?;
    let mut st = vault().lock().map_err(|e| e.to_string())?;
    st.master = Some(Zeroizing::new(master_password));
    st.data = data;
    Ok(())
}

#[tauri::command]
pub fn vault_lock() -> Result<(), String> {
    let mut st = vault().lock().map_err(|e| e.to_string())?;
    st.master = None;
    st.data.clear();
    Ok(())
}

#[tauri::command]
pub fn credential_set(session_id: String, password: String) -> Result<(), String> {
    let mut st = vault().lock().map_err(|e| e.to_string())?;
    let master = st.master.clone().ok_or("Vault is locked")?;
    st.data.insert(session_id, password);
    save_to_disk(&master, &st.data)
}

/// `Err("Vault is locked")` tells the frontend to prompt for the master
/// password and retry.
#[tauri::command]
pub fn credential_get(session_id: String) -> Result<Option<String>, String> {
    let st = vault().lock().map_err(|e| e.to_string())?;
    if st.master.is_none() {
        return Err("Vault is locked".to_string());
    }
    Ok(st.data.get(&session_id).cloned())
}

#[tauri::command]
pub fn credential_delete(session_id: String) -> Result<(), String> {
    let mut st = vault().lock().map_err(|e| e.to_string())?;
    let Some(master) = st.master.clone() else {
        return Ok(()); // locked vault: nothing to delete from memory/disk view
    };
    if st.data.remove(&session_id).is_some() {
        save_to_disk(&master, &st.data)?;
    }
    Ok(())
}
