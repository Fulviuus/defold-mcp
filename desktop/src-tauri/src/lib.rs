mod agents;
mod server;

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Persisted app settings (stored in the app config dir as settings.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Path to the node executable used to launch the server.
    pub node_path: String,
    /// Path to the built MCP server entry point (dist/index.js).
    pub server_entry: String,
    /// Host the HTTP server binds to.
    pub host: String,
    /// Port the HTTP server binds to.
    pub port: u16,
    /// Defold project root forwarded as DEFOLD_PROJECT_ROOT (optional).
    pub project_root: String,
    /// JAVA_HOME forwarded to the server for bob.jar (optional).
    pub java_home: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            node_path: detect_node(),
            // Empty = use the server.cjs embedded in the app bundle.
            server_entry: String::new(),
            host: "127.0.0.1".into(),
            port: 9810,
            project_root: String::new(),
            java_home: detect_java_home(),
        }
    }
}

/// Resolve which server entry point to launch / point agents at:
/// 1. an explicit path from Settings (power users, dev override),
/// 2. the server.cjs bundled into the app as a Tauri resource,
/// 3. the dev-checkout dist/index.js (running via `tauri dev` from the repo).
pub fn resolve_server_entry(app: &tauri::AppHandle, configured: &str) -> String {
    let configured = configured.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    if let Ok(p) = app
        .path()
        .resolve("resources/server.cjs", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    default_server_entry()
}

/// Locate node via a login shell so version managers (nvm, fnm) are honored.
fn detect_node() -> String {
    #[cfg(unix)]
    {
        if let Ok(out) = Command::new("/bin/sh").args(["-lc", "command -v node"]).output() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if PathBuf::from(candidate).exists() {
                return candidate.to_string();
            }
        }
    }
    "node".to_string()
}

/// In a dev checkout the server lives two directories up from src-tauri.
fn default_server_entry() -> String {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dist")
        .join("index.js");
    match dev_path.canonicalize() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => dev_path.to_string_lossy().to_string(),
    }
}

fn detect_java_home() -> String {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.is_empty() && PathBuf::from(&home).exists() {
            return home;
        }
    }
    let candidates = [
        "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
        "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    ];
    for c in candidates {
        if PathBuf::from(c).exists() {
            return c.to_string();
        }
    }
    String::new()
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Settings saved by pre-embedding versions of the app stored the dev-checkout
/// dist path as an explicit value. Treat exactly that value as "unset" so those
/// installs migrate to the embedded server automatically.
fn is_legacy_default_entry(entry: &str) -> bool {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return false;
    }
    let default = default_server_entry();
    if trimmed == default {
        return true;
    }
    match (PathBuf::from(trimmed).canonicalize(), PathBuf::from(&default).canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(mut s) = serde_json::from_str::<Settings>(&text) {
            if is_legacy_default_entry(&s.server_entry) {
                s.server_entry = String::new();
            }
            return Ok(s);
        }
    }
    Ok(Settings::default())
}

#[tauri::command]
async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Reveal a file in the OS file manager.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg("/select,").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open")
        .arg(PathBuf::from(&path).parent().map(|p| p.to_path_buf()).unwrap_or_default())
        .spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(server::ServerState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            reveal_path,
            server::start_server,
            server::stop_server,
            server::server_status,
            agents::list_agents,
            agents::configure_agent,
        ])
        .on_window_event(|window, event| {
            // Stop the managed server when the app window closes.
            if let tauri::WindowEvent::Destroyed = event {
                let state: tauri::State<server::ServerState> = window.app_handle().state();
                server::kill_managed(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
