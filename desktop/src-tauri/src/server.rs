//! Manages the Node MCP server child process: spawn with the chosen
//! host/port, stream its output to the UI as events, stop it gracefully.
//!
//! Concurrency model: `ServerState` holds at most one `Managed` child, tagged
//! with a generation number. The exit-watcher thread only acts on its own
//! generation, so rapid stop/start cycles cannot make a stale watcher touch a
//! new child. Whichever party reaps a dead child (watcher or a status poll)
//! emits the `server-exit` event exactly once. Stop takes the child out of
//! the mutex before the (blocking) graceful kill, and the blocking commands
//! are async so they never run on the Tauri main thread.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::Settings;

pub struct Managed {
    child: Child,
    pub generation: u64,
    pub host: String,
    pub port: u16,
    pub started_at: Instant,
}

#[derive(Default)]
pub struct ServerState {
    inner: Arc<Mutex<Option<Managed>>>,
    next_generation: std::sync::atomic::AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusPayload {
    pub running: bool,
    pub pid: Option<u32>,
    pub url: Option<String>,
    pub uptime_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct LogEvent {
    stream: &'static str,
    line: String,
}

fn status_from(managed: &Option<Managed>) -> StatusPayload {
    match managed {
        Some(m) => StatusPayload {
            running: true,
            pid: Some(m.child.id()),
            url: Some(format!("http://{}:{}/mcp", display_host(&m.host), m.port)),
            uptime_seconds: Some(m.started_at.elapsed().as_secs()),
        },
        None => StatusPayload { running: false, pid: None, url: None, uptime_seconds: None },
    }
}

/// 0.0.0.0 binds all interfaces but is not a connectable address.
pub fn display_host(host: &str) -> &str {
    if host == "0.0.0.0" || host == "::" {
        "127.0.0.1"
    } else {
        host
    }
}

#[tauri::command]
pub async fn start_server(
    app: AppHandle,
    state: State<'_, ServerState>,
    settings: Settings,
) -> Result<StatusPayload, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(m) = guard.as_mut() {
        if m.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("Server is already running. Stop it first.".into());
        }
        *guard = None;
    }

    let server_entry = crate::resolve_server_entry(&app, &settings.server_entry);
    if !PathBuf::from(&server_entry).exists() {
        return Err(format!(
            "Server entry not found: {server_entry}. The app bundle should embed it; if running from a dev checkout, run `npm run bundle:server` (or `npm run build`) in the defold-mcp repo, or set an explicit path in Settings."
        ));
    }

    // Reclaim the port if a previous server was orphaned (app crash/force-kill).
    if let Some(note) = reclaim_orphaned_port(&settings.host, settings.port)? {
        let _ = app.emit("server-log", LogEvent { stream: "stderr", line: note });
    }

    let mut cmd = Command::new(&settings.node_path);
    cmd.arg(&server_entry)
        .args(["--transport", "http"])
        .args(["--host", &settings.host])
        .args(["--port", &settings.port.to_string()])
        .arg("--exit-with-parent")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !settings.project_root.trim().is_empty() {
        cmd.env("DEFOLD_PROJECT_ROOT", settings.project_root.trim());
    }
    if !settings.java_home.trim().is_empty() {
        cmd.env("JAVA_HOME", settings.java_home.trim());
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to launch '{}': {}. Check the Node path in Settings.",
            settings.node_path, e
        )
    })?;

    // Stream both pipes to the UI.
    if let Some(stdout) = child.stdout.take() {
        spawn_reader(app.clone(), "stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(app.clone(), "stderr", stderr);
    }

    let generation = state
        .next_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *guard = Some(Managed {
        child,
        generation,
        host: settings.host.clone(),
        port: settings.port,
        started_at: Instant::now(),
    });
    let payload = status_from(&guard);
    drop(guard);

    // Exit watcher for THIS generation: clears state and notifies the UI when
    // the process dies. A stale watcher exits as soon as the generation moves.
    let state_arc = state.inner.clone();
    let app_exit = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(400));
        let mut guard = match state_arc.lock() {
            Ok(g) => g,
            Err(_) => break,
        };
        match guard.as_mut() {
            Some(m) if m.generation != generation => break, // a newer server took over
            Some(m) => match m.child.try_wait() {
                Ok(Some(status)) => {
                    let _ = app_exit.emit("server-exit", status.code());
                    *guard = None;
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    let _ = app_exit.emit("server-exit", None::<i32>);
                    *guard = None;
                    break;
                }
            },
            None => break, // stopped (user action emits no exit event)
        }
    });

    Ok(payload)
}

fn spawn_reader<R: std::io::Read + Send + 'static>(app: AppHandle, stream: &'static str, pipe: R) {
    std::thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let _ = app.emit("server-log", LogEvent { stream, line });
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
pub async fn stop_server(state: State<'_, ServerState>) -> Result<StatusPayload, String> {
    // Take the child out of the mutex so the (slow) kill never blocks other
    // commands; the watcher sees None and winds down without emitting.
    let managed = {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(mut m) = managed {
        graceful_kill(&mut m.child);
    }
    Ok(StatusPayload { running: false, pid: None, url: None, uptime_seconds: None })
}

#[tauri::command]
pub async fn server_status(
    app: AppHandle,
    state: State<'_, ServerState>,
) -> Result<StatusPayload, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(m) = guard.as_mut() {
        if let Ok(Some(status)) = m.child.try_wait() {
            // This poll reaped the child before the watcher did: emit the
            // exit event here so the UI never misses a crash.
            let _ = app.emit("server-exit", status.code());
            *guard = None;
        }
    }
    Ok(status_from(&guard))
}

/// If something is already listening on the chosen port, identify it via
/// GET /health. A leftover defold-mcp server (orphaned by an app crash or
/// force-kill) is stopped so the port can be reused; anything else is a
/// clear error instead of a confusing node EADDRINUSE in the console.
fn reclaim_orphaned_port(host: &str, port: u16) -> Result<Option<String>, String> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};

    let addr_str = format!("{}:{}", display_host(host), port);
    let Ok(addr) = addr_str.parse::<SocketAddr>() else {
        return Ok(None); // hostname binds: let the server report listen errors
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return Ok(None); // port free
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.write_all(
        format!("GET /health HTTP/1.1\r\nHost: {addr_str}\r\nConnection: close\r\n\r\n").as_bytes(),
    );
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    drop(stream);

    if !response.contains("defold-mcp-server") {
        return Err(format!(
            "Port {port} is already in use by another application. Choose a different port."
        ));
    }

    #[cfg(unix)]
    {
        if let Ok(out) = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
            .output()
        {
            let pids: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            if !pids.is_empty() {
                for pid in &pids {
                    let _ = Command::new("kill").arg(pid).status();
                }
                std::thread::sleep(Duration::from_millis(600));
                return Ok(Some(format!(
                    "[app] stopped an orphaned defold-mcp server (pid {}) to free port {port}",
                    pids.join(", ")
                )));
            }
        }
    }
    Err(format!(
        "Port {port} is held by an orphaned defold-mcp server that could not be stopped automatically. \
         Run: lsof -ti tcp:{port} | xargs kill"
    ))
}

/// SIGTERM first so the server can stop launched games, then SIGKILL.
fn graceful_kill(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("kill").args(["-TERM", &pid]).status();
        for _ in 0..20 {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Used by the window-close handler (synchronous; the app is exiting anyway).
pub fn kill_managed(state: &State<ServerState>) {
    let managed = match state.inner.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    if let Some(mut m) = managed {
        graceful_kill(&mut m.child);
    }
}
