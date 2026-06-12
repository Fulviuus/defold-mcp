//! Agent auto-configuration: knows where each AI coding agent keeps its MCP
//! config and how to merge a "defold" server entry into it (the same pattern
//! as Unity MCP's client dropdown). Existing files are backed up before any
//! write; files that fail to parse are never touched (a paste-ready snippet
//! is returned instead).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use toml_edit::{value, Array, DocumentMut, InlineTable, Item, Table};

use crate::server::display_host;
use crate::Settings;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    Http,
    Stdio,
}

impl Mode {
    fn parse(s: &str) -> Result<Mode, String> {
        match s {
            "http" => Ok(Mode::Http),
            "stdio" => Ok(Mode::Stdio),
            other => Err(format!("Unknown mode '{other}'. Use \"http\" or \"stdio\".")),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub config_path: String,
    pub configured: bool,
    pub supports_http: bool,
    pub supports_stdio: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigureResult {
    pub agent: String,
    pub mode: String,
    pub config_path: String,
    pub backup_path: Option<String>,
    pub wrote: bool,
    pub snippet: String,
    pub message: String,
}

struct AgentDef {
    id: &'static str,
    label: &'static str,
    supports_http: bool,
    supports_stdio: bool,
    note: &'static str,
}

const AGENTS: &[AgentDef] = &[
    AgentDef { id: "claude-code", label: "Claude Code", supports_http: true, supports_stdio: true,
        note: "Writes project-scoped .mcp.json into the Defold project root." },
    AgentDef { id: "claude-desktop", label: "Claude Desktop", supports_http: true, supports_stdio: true,
        note: "HTTP mode uses the mcp-remote bridge (npx) since the config file only supports stdio servers." },
    AgentDef { id: "codex", label: "OpenAI Codex (CLI + desktop + IDE)", supports_http: true, supports_stdio: true,
        note: "One config covers all Codex clients: the CLI, the desktop app and the IDE extension all read ~/.codex/config.toml. stdio entries get raised tool timeouts for long builds." },
    AgentDef { id: "cursor", label: "Cursor", supports_http: true, supports_stdio: true,
        note: "Writes the global ~/.cursor/mcp.json (all projects)." },
    AgentDef { id: "gemini", label: "Gemini CLI", supports_http: true, supports_stdio: true,
        note: "Writes user-scope ~/.gemini/settings.json." },
    AgentDef { id: "vscode", label: "VS Code (Copilot)", supports_http: true, supports_stdio: true,
        note: "Writes the user-profile mcp.json (key is \"servers\")." },
    AgentDef { id: "windsurf", label: "Windsurf", supports_http: true, supports_stdio: true,
        note: "Writes ~/.codeium/windsurf/mcp_config.json; refresh servers from the Cascade MCP panel." },
    AgentDef { id: "cline", label: "Cline (VS Code)", supports_http: false, supports_stdio: true,
        note: "stdio only; Cline manages this file, so reload VS Code after configuring." },
    AgentDef { id: "zed", label: "Zed", supports_http: false, supports_stdio: true,
        note: "stdio only (key is \"context_servers\"). Zed settings may contain comments; if so a snippet is returned for manual paste." },
];

// ---------------------------------------------------------------------------
// Paths (parameterized by home for testability)
// ---------------------------------------------------------------------------

fn app_support(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    return home.join("Library").join("Application Support");
    #[cfg(target_os = "windows")]
    return home.join("AppData").join("Roaming");
    #[cfg(all(unix, not(target_os = "macos")))]
    return home.join(".config");
}

fn detect_dir(home: &Path, id: &str) -> PathBuf {
    match id {
        "claude-code" => home.join(".claude"),
        "claude-desktop" => app_support(home).join("Claude"),
        "codex" => home.join(".codex"),
        "cursor" => home.join(".cursor"),
        "gemini" => home.join(".gemini"),
        "vscode" => app_support(home).join("Code").join("User"),
        "windsurf" => home.join(".codeium").join("windsurf"),
        "cline" => app_support(home)
            .join("Code").join("User").join("globalStorage").join("saoudrizwan.claude-dev"),
        "zed" => home.join(".config").join("zed"),
        _ => home.to_path_buf(),
    }
}

fn config_path(home: &Path, id: &str, project_root: &str) -> PathBuf {
    match id {
        "claude-code" => PathBuf::from(project_root).join(".mcp.json"),
        "claude-desktop" => app_support(home).join("Claude").join("claude_desktop_config.json"),
        "codex" => home.join(".codex").join("config.toml"),
        "cursor" => home.join(".cursor").join("mcp.json"),
        "gemini" => home.join(".gemini").join("settings.json"),
        "vscode" => app_support(home).join("Code").join("User").join("mcp.json"),
        "windsurf" => home.join(".codeium").join("windsurf").join("mcp_config.json"),
        "cline" => detect_dir(home, "cline").join("settings").join("cline_mcp_settings.json"),
        "zed" => home.join(".config").join("zed").join("settings.json"),
        _ => home.to_path_buf(),
    }
}

fn top_key(id: &str) -> &'static str {
    match id {
        "vscode" => "servers",
        "zed" => "context_servers",
        _ => "mcpServers",
    }
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

pub fn http_url(settings: &Settings) -> String {
    format!("http://{}:{}/mcp", display_host(&settings.host), settings.port)
}

fn env_map(settings: &Settings) -> Map<String, Value> {
    let mut env = Map::new();
    if !settings.project_root.trim().is_empty() {
        env.insert("DEFOLD_PROJECT_ROOT".into(), json!(settings.project_root.trim()));
    }
    if !settings.java_home.trim().is_empty() {
        env.insert("JAVA_HOME".into(), json!(settings.java_home.trim()));
    }
    env
}

fn stdio_entry(settings: &Settings, with_type: bool) -> Value {
    let mut obj = Map::new();
    if with_type {
        obj.insert("type".into(), json!("stdio"));
    }
    obj.insert("command".into(), json!(settings.node_path));
    obj.insert("args".into(), json!([settings.server_entry]));
    let env = env_map(settings);
    if !env.is_empty() {
        obj.insert("env".into(), Value::Object(env));
    }
    Value::Object(obj)
}

/// JSON entry for one agent in one mode (None = combination unsupported).
fn json_entry(id: &str, mode: Mode, settings: &Settings) -> Option<Value> {
    let url = http_url(settings);
    match (id, mode) {
        ("claude-code", Mode::Http) => Some(json!({ "type": "http", "url": url })),
        ("claude-code", Mode::Stdio) => Some(stdio_entry(settings, false)),
        ("claude-desktop", Mode::Http) => Some(json!({
            "command": "npx",
            "args": ["-y", "mcp-remote", url]
        })),
        ("claude-desktop", Mode::Stdio) => Some(stdio_entry(settings, false)),
        ("cursor", Mode::Http) => Some(json!({ "url": url })),
        ("cursor", Mode::Stdio) => Some(stdio_entry(settings, false)),
        ("gemini", Mode::Http) => Some(json!({ "httpUrl": url })),
        ("gemini", Mode::Stdio) => Some(stdio_entry(settings, false)),
        ("vscode", Mode::Http) => Some(json!({ "type": "http", "url": url })),
        ("vscode", Mode::Stdio) => Some(stdio_entry(settings, true)),
        ("windsurf", Mode::Http) => Some(json!({ "serverUrl": url })),
        ("windsurf", Mode::Stdio) => Some(stdio_entry(settings, false)),
        ("cline", Mode::Stdio) => {
            let mut entry = stdio_entry(settings, false);
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("disabled".into(), json!(false));
                obj.insert("autoApprove".into(), json!([]));
            }
            Some(entry)
        }
        ("zed", Mode::Stdio) => Some(stdio_entry(settings, false)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// File merge helpers
// ---------------------------------------------------------------------------

/// Copy the config aside before the first write. The backup is only written
/// once — re-configuring must not clobber the pristine original.
fn backup(path: &Path) -> Result<Option<String>, String> {
    if path.exists() {
        let backup_path = path.with_extension(
            format!("{}.defold-mcp.bak", path.extension().and_then(|e| e.to_str()).unwrap_or("cfg")),
        );
        if !backup_path.exists() {
            std::fs::copy(path, &backup_path)
                .map_err(|e| format!("Could not create backup {}: {e}", backup_path.display()))?;
        }
        return Ok(Some(backup_path.to_string_lossy().to_string()));
    }
    Ok(None)
}

/// Read an existing config; only a missing file counts as empty. Any other
/// read failure (permissions, invalid UTF-8) must abort instead of silently
/// replacing the user's config with a fresh one.
fn read_config(path: &Path, empty: &str) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(empty.to_string()),
        Err(e) => Err(format!(
            "Could not read the existing config at {} ({e}). Not writing anything — fix the file or paste the snippet manually.",
            path.display()
        )),
    }
}

/// Atomically replace `path` with `contents` (temp file + rename), so a
/// crash mid-write can never leave the agent's config truncated.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!(
        "{}.defold-mcp.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("cfg")
    ));
    std::fs::write(&tmp, contents).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not replace {}: {e}", path.display())
    })
}

pub fn merge_json_config(
    path: &Path,
    container_key: &str,
    server_name: &str,
    entry: Value,
) -> Result<Option<String>, String> {
    let text = read_config(path, "{}")?;
    let mut root: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "Existing config is not plain JSON ({e}). It may contain comments — paste the snippet manually instead."
        )
    })?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "Existing config root is not a JSON object.".to_string())?;
    let container = obj
        .entry(container_key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let container_obj = container
        .as_object_mut()
        .ok_or_else(|| format!("\"{container_key}\" in the existing config is not an object."))?;
    container_obj.insert(server_name.to_string(), entry);

    let backup_path = backup(path)?;
    let mut out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    out.push('\n');
    write_atomic(path, &out)?;
    Ok(backup_path)
}

fn codex_table(settings: &Settings, mode: Mode) -> Table {
    let mut t = Table::new();
    match mode {
        Mode::Http => {
            t["url"] = value(http_url(settings));
        }
        Mode::Stdio => {
            t["command"] = value(settings.node_path.clone());
            let mut args = Array::new();
            args.push(settings.server_entry.clone());
            t["args"] = value(args);
            t["startup_timeout_sec"] = value(30i64);
            t["tool_timeout_sec"] = value(600i64);
            let mut env = InlineTable::new();
            if !settings.project_root.trim().is_empty() {
                env.insert("DEFOLD_PROJECT_ROOT", settings.project_root.trim().into());
            }
            if !settings.java_home.trim().is_empty() {
                env.insert("JAVA_HOME", settings.java_home.trim().into());
            }
            if !env.is_empty() {
                t["env"] = value(env);
            }
        }
    }
    t
}

pub fn merge_codex_config(path: &Path, settings: &Settings, mode: Mode) -> Result<Option<String>, String> {
    let text = read_config(path, "")?;
    let mut doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("Existing config.toml could not be parsed ({e})."))?;
    if doc.get("mcp_servers").is_none() {
        let mut t = Table::new();
        t.set_implicit(true);
        doc["mcp_servers"] = Item::Table(t);
    }
    // Never index into a non-table (toml_edit panics on type mismatch).
    let servers = doc["mcp_servers"].as_table_mut().ok_or_else(|| {
        "\"mcp_servers\" in config.toml exists but is not a table — fix it manually, then retry.".to_string()
    })?;
    servers.insert("defold", Item::Table(codex_table(settings, mode)));

    let backup_path = backup(path)?;
    write_atomic(path, &doc.to_string())?;
    Ok(backup_path)
}

fn snippet_for(id: &str, mode: Mode, settings: &Settings) -> String {
    if id == "codex" {
        let mut doc = DocumentMut::new();
        let mut t = Table::new();
        t.set_implicit(true);
        doc["mcp_servers"] = Item::Table(t);
        doc["mcp_servers"]["defold"] = Item::Table(codex_table(settings, mode));
        return doc.to_string();
    }
    let entry = json_entry(id, mode, settings).unwrap_or(Value::Null);
    serde_json::to_string_pretty(&json!({ top_key(id): { "defold": entry } })).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not determine the home directory.".to_string())
}

#[tauri::command]
pub async fn list_agents(settings: Settings) -> Result<Vec<AgentInfo>, String> {
    let home = home_dir()?;
    let mut out = Vec::new();
    for def in AGENTS {
        let path = config_path(&home, def.id, &settings.project_root);
        let display_path = if def.id == "claude-code" && settings.project_root.trim().is_empty() {
            "<project root>/.mcp.json (set Project Root first)".to_string()
        } else {
            path.to_string_lossy().to_string()
        };
        let configured = std::fs::read_to_string(&path)
            .map(|text| text.contains("defold"))
            .unwrap_or(false);
        out.push(AgentInfo {
            id: def.id.to_string(),
            label: def.label.to_string(),
            installed: detect_dir(&home, def.id).exists(),
            config_path: display_path,
            configured,
            supports_http: def.supports_http,
            supports_stdio: def.supports_stdio,
            note: def.note.to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn configure_agent(
    app: tauri::AppHandle,
    settings: Settings,
    agent_id: String,
    mode: String,
) -> Result<ConfigureResult, String> {
    // stdio configs must reference a concrete entry point: an explicit
    // override, the server.cjs embedded in this app, or the dev checkout.
    let mut settings = settings;
    settings.server_entry = crate::resolve_server_entry(&app, &settings.server_entry);
    let mode = Mode::parse(&mode)?;
    let def = AGENTS
        .iter()
        .find(|d| d.id == agent_id)
        .ok_or_else(|| format!("Unknown agent '{agent_id}'."))?;
    if (mode == Mode::Http && !def.supports_http) || (mode == Mode::Stdio && !def.supports_stdio) {
        return Err(format!("{} does not support {:?} mode.", def.label, mode));
    }
    if agent_id == "claude-code" && settings.project_root.trim().is_empty() {
        return Err("Claude Code is configured per project: set the Defold Project Root first.".into());
    }
    if mode == Mode::Stdio && !PathBuf::from(&settings.server_entry).exists() {
        return Err(format!(
            "stdio mode points the agent at {} which does not exist. Build the server first (npm run build).",
            settings.server_entry
        ));
    }

    let home = home_dir()?;
    let path = config_path(&home, &agent_id, settings.project_root.trim());
    let snippet = snippet_for(&agent_id, mode, &settings);
    let mode_str = if mode == Mode::Http { "http" } else { "stdio" };

    let merge_result = if agent_id == "codex" {
        merge_codex_config(&path, &settings, mode)
    } else {
        let entry = json_entry(&agent_id, mode, &settings)
            .ok_or_else(|| format!("{} does not support {mode_str} mode.", def.label))?;
        merge_json_config(&path, top_key(&agent_id), "defold", entry)
    };

    match merge_result {
        Ok(backup_path) => Ok(ConfigureResult {
            agent: agent_id.clone(),
            mode: mode_str.into(),
            config_path: path.to_string_lossy().to_string(),
            backup_path,
            wrote: true,
            snippet,
            message: format!(
                "Configured {} ({}). Restart or refresh the agent to pick up the new server.{}",
                def.label,
                mode_str,
                if mode == Mode::Http { " Make sure the server is running in this app." } else { "" }
            ),
        }),
        Err(err) => Ok(ConfigureResult {
            agent: agent_id,
            mode: mode_str.into(),
            config_path: path.to_string_lossy().to_string(),
            backup_path: None,
            wrote: false,
            snippet,
            message: format!("Did not write the file: {err}"),
        }),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            node_path: "/usr/local/bin/node".into(),
            server_entry: "/repo/dist/index.js".into(),
            host: "127.0.0.1".into(),
            port: 9810,
            project_root: "/games/mygame".into(),
            java_home: "/java/home".into(),
        }
    }

    #[test]
    fn http_url_rewrites_wildcard_host() {
        let mut s = settings();
        s.host = "0.0.0.0".into();
        assert_eq!(http_url(&s), "http://127.0.0.1:9810/mcp");
    }

    #[test]
    fn merge_into_missing_file_creates_structure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("mcp.json");
        let entry = json_entry("cursor", Mode::Http, &settings()).unwrap();
        let backup = merge_json_config(&path, "mcpServers", "defold", entry).unwrap();
        assert!(backup.is_none());
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["mcpServers"]["defold"]["url"], "http://127.0.0.1:9810/mcp");
    }

    #[test]
    fn merge_preserves_existing_servers_and_creates_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, r#"{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}"#).unwrap();
        let entry = json_entry("cursor", Mode::Stdio, &settings()).unwrap();
        let backup = merge_json_config(&path, "mcpServers", "defold", entry).unwrap();
        assert!(backup.is_some());
        assert!(PathBuf::from(backup.unwrap()).exists());
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["mcpServers"]["other"]["command"], "x");
        assert_eq!(written["theme"], "dark");
        assert_eq!(written["mcpServers"]["defold"]["command"], "/usr/local/bin/node");
        assert_eq!(written["mcpServers"]["defold"]["env"]["DEFOLD_PROJECT_ROOT"], "/games/mygame");
    }

    #[test]
    fn merge_rejects_jsonc() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{\n  // a comment\n  \"context_servers\": {}\n}").unwrap();
        let entry = json_entry("zed", Mode::Stdio, &settings()).unwrap();
        let err = merge_json_config(&path, "context_servers", "defold", entry).unwrap_err();
        assert!(err.contains("not plain JSON"));
        // original untouched
        assert!(std::fs::read_to_string(&path).unwrap().contains("// a comment"));
    }

    #[test]
    fn codex_toml_merge_preserves_unrelated_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "model = \"o5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n").unwrap();
        merge_codex_config(&path, &settings(), Mode::Stdio).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("model = \"o5\""));
        assert!(text.contains("[mcp_servers.other]"));
        assert!(text.contains("[mcp_servers.defold]"));
        assert!(text.contains("tool_timeout_sec = 600"));
        assert!(text.contains("DEFOLD_PROJECT_ROOT = \"/games/mygame\""));
        // still valid toml
        let _doc: DocumentMut = text.parse().unwrap();
    }

    #[test]
    fn codex_http_mode_writes_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        merge_codex_config(&path, &settings(), Mode::Http).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("url = \"http://127.0.0.1:9810/mcp\""));
        assert!(!text.contains("command"));
    }

    #[test]
    fn entries_match_each_clients_dialect() {
        let s = settings();
        assert_eq!(json_entry("gemini", Mode::Http, &s).unwrap()["httpUrl"], "http://127.0.0.1:9810/mcp");
        assert_eq!(json_entry("windsurf", Mode::Http, &s).unwrap()["serverUrl"], "http://127.0.0.1:9810/mcp");
        assert_eq!(json_entry("vscode", Mode::Http, &s).unwrap()["type"], "http");
        assert_eq!(json_entry("vscode", Mode::Stdio, &s).unwrap()["type"], "stdio");
        assert_eq!(json_entry("claude-desktop", Mode::Http, &s).unwrap()["command"], "npx");
        assert_eq!(json_entry("cline", Mode::Stdio, &s).unwrap()["disabled"], false);
        assert!(json_entry("cline", Mode::Http, &s).is_none());
        assert!(json_entry("zed", Mode::Http, &s).is_none());
    }

    #[test]
    fn backup_keeps_the_pristine_original_across_reconfigures() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, r#"{"mcpServers":{"original":true}}"#).unwrap();
        let e1 = json_entry("cursor", Mode::Http, &settings()).unwrap();
        let bak = merge_json_config(&path, "mcpServers", "defold", e1).unwrap().unwrap();
        // Reconfigure with a different mode: .bak must still hold the original.
        let e2 = json_entry("cursor", Mode::Stdio, &settings()).unwrap();
        merge_json_config(&path, "mcpServers", "defold", e2).unwrap();
        let backup_text = std::fs::read_to_string(&bak).unwrap();
        assert!(backup_text.contains("\"original\""));
        assert!(!backup_text.contains("defold"));
    }

    #[test]
    fn unreadable_existing_config_aborts_instead_of_replacing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        // Invalid UTF-8: read_to_string fails with a non-NotFound error.
        std::fs::write(&path, [0xff, 0xfe, 0x80]).unwrap();
        let entry = json_entry("cursor", Mode::Http, &settings()).unwrap();
        let err = merge_json_config(&path, "mcpServers", "defold", entry).unwrap_err();
        assert!(err.contains("Not writing anything"));
        assert_eq!(std::fs::read(&path).unwrap(), vec![0xff, 0xfe, 0x80]);
    }

    #[test]
    fn codex_non_table_mcp_servers_errors_instead_of_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "mcp_servers = \"oops\"\n").unwrap();
        let err = merge_codex_config(&path, &settings(), Mode::Stdio).unwrap_err();
        assert!(err.contains("not a table"));
        assert!(std::fs::read_to_string(&path).unwrap().contains("oops"));
    }

    #[test]
    fn json_merge_preserves_key_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"zeta":1,"mcpServers":{},"alpha":2}"#).unwrap();
        let entry = json_entry("cursor", Mode::Http, &settings()).unwrap();
        merge_json_config(&path, "mcpServers", "defold", entry).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let zeta = text.find("zeta").unwrap();
        let servers = text.find("mcpServers").unwrap();
        let alpha = text.find("alpha").unwrap();
        assert!(zeta < servers && servers < alpha, "key order was not preserved: {text}");
    }

    #[test]
    fn top_keys_match_clients() {
        assert_eq!(top_key("vscode"), "servers");
        assert_eq!(top_key("zed"), "context_servers");
        assert_eq!(top_key("cursor"), "mcpServers");
    }
}
