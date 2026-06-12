// Defold MCP desktop app frontend (no bundler; Tauri global API).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const MAX_CONSOLE_LINES = 5000;

let settings = null;
let agents = [];
let running = false;
let lastConfigPath = null;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsFromForm() {
  const parsedPort = parseInt($("port").value, 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 9810;
  if (String(port) !== $("port").value.trim()) $("port").value = port;
  return {
    node_path: $("node_path").value.trim(),
    // Not exposed in the UI: the app uses its embedded server. A manual
    // value in settings.json is preserved as a power-user override.
    server_entry: settings?.server_entry ?? "",
    host: $("host").value,
    port,
    project_root: $("project_root").value.trim(),
    java_home: $("java_home").value.trim(),
  };
}

function fillForm(s) {
  $("node_path").value = s.node_path;
  $("host").value = s.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  $("port").value = s.port;
  $("project_root").value = s.project_root;
  $("java_home").value = s.java_home;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = settingsFromForm();
    try {
      await invoke("save_settings", { settings });
    } catch (e) {
      appendLog("meta", `Could not save settings: ${e}`);
    }
    refreshAgents();
  }, 400);
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

function appendLog(kind, line) {
  const consoleEl = $("console");
  const span = document.createElement("span");
  let cls = "";
  if (kind === "meta") cls = "log-meta";
  else if (/ERROR|FATAL|✗|Exception/i.test(line)) cls = "log-err";
  else if (/WARNING|WARN/i.test(line)) cls = "log-warn";
  else if (/\btool defold_\w+ ->/.test(line)) cls = "log-tool";
  span.className = cls;
  span.textContent = line + "\n";
  consoleEl.appendChild(span);
  while (consoleEl.childNodes.length > MAX_CONSOLE_LINES) {
    consoleEl.removeChild(consoleEl.firstChild);
  }
  if ($("autoscroll").checked) consoleEl.scrollTop = consoleEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function setRunning(state, url) {
  running = state;
  const pill = $("status-pill");
  pill.className = `pill ${state ? "running" : "stopped"}`;
  pill.textContent = state ? "running" : "stopped";
  $("start").disabled = state;
  $("stop").disabled = !state;
  $("host").disabled = state;
  $("port").disabled = state;
  $("url-display").textContent = state && url ? url : "";
}

async function refreshStatus() {
  try {
    const status = await invoke("server_status");
    setRunning(status.running, status.url);
    if (status.running && status.url) {
      try {
        const health = await fetch(status.url.replace(/\/mcp$/, "/health"), { signal: AbortSignal.timeout(1500) });
        if (health.ok) {
          const h = await health.json();
          $("status-pill").textContent = `running · ${h.tools} tools · pid ${status.pid}`;
        }
      } catch {
        // health endpoint not reachable yet; keep basic status
      }
    }
  } catch (e) {
    appendLog("meta", `status check failed: ${e}`);
  }
}

async function startServer() {
  settings = settingsFromForm();
  await invoke("save_settings", { settings }).catch(() => {});
  appendLog("meta", `Starting: ${settings.node_path} ${settings.server_entry || "(embedded server)"} --transport http --host ${settings.host} --port ${settings.port}`);
  try {
    const status = await invoke("start_server", { settings });
    setRunning(status.running, status.url);
  } catch (e) {
    appendLog("meta", `Start failed: ${e}`);
  }
}

async function stopServer() {
  try {
    await invoke("stop_server");
    appendLog("meta", "Server stopped.");
  } catch (e) {
    appendLog("meta", `Stop failed: ${e}`);
  }
  refreshStatus();
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function renderAgents() {
  const select = $("agent-select");
  const previous = select.value;
  select.innerHTML = "";
  for (const a of agents) {
    const opt = document.createElement("option");
    opt.value = a.id;
    const badges = [
      a.installed ? "detected" : "not detected",
      a.configured ? "✓ configured" : null,
    ].filter(Boolean).join(", ");
    opt.textContent = `${a.label} (${badges})`;
    select.appendChild(opt);
  }
  if (previous && agents.some((a) => a.id === previous)) select.value = previous;
  onAgentChange();
}

function selectedAgent() {
  return agents.find((a) => a.id === $("agent-select").value);
}

function onAgentChange() {
  const agent = selectedAgent();
  if (!agent) return;
  const mode = $("mode-select");
  const httpOpt = mode.querySelector('option[value="http"]');
  const stdioOpt = mode.querySelector('option[value="stdio"]');
  httpOpt.disabled = !agent.supports_http;
  stdioOpt.disabled = !agent.supports_stdio;
  if (mode.selectedOptions[0]?.disabled) {
    mode.value = agent.supports_http ? "http" : "stdio";
  }
  $("agent-note").textContent = `${agent.note} Config: ${agent.config_path}`;
}

async function refreshAgents() {
  try {
    agents = await invoke("list_agents", { settings: settingsFromForm() });
    renderAgents();
  } catch (e) {
    appendLog("meta", `agent detection failed: ${e}`);
  }
}

async function configureAgent() {
  const agent = selectedAgent();
  if (!agent) return;
  const mode = $("mode-select").value;
  try {
    const result = await invoke("configure_agent", {
      settings: settingsFromForm(),
      agentId: agent.id,
      mode,
    });
    $("configure-result").classList.remove("hidden");
    $("result-message").textContent = result.message;
    $("result-paths").textContent =
      `File: ${result.config_path}` +
      (result.backup_path ? ` — backup saved to ${result.backup_path}` : "");
    $("result-snippet").textContent = result.snippet;
    lastConfigPath = result.wrote ? result.config_path : null;
    $("reveal-config").disabled = !result.wrote;
    appendLog("meta", `${result.wrote ? "Configured" : "Prepared snippet for"} ${agent.label} (${mode}).`);
    if (mode === "http" && !running) {
      appendLog("meta", "Note: the server is not running — start it before using the agent.");
    }
    refreshAgents();
  } catch (e) {
    $("configure-result").classList.remove("hidden");
    $("result-message").textContent = `Error: ${e}`;
    $("result-paths").textContent = "";
    $("result-snippet").textContent = "";
    $("reveal-config").disabled = true;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function init() {
  settings = await invoke("get_settings");
  fillForm(settings);

  await listen("server-log", (event) => {
    appendLog(event.payload.stream, event.payload.line);
  });
  await listen("server-exit", (event) => {
    appendLog("meta", `Server process exited (code ${event.payload ?? "unknown"}).`);
    refreshStatus();
  });

  $("start").addEventListener("click", startServer);
  $("stop").addEventListener("click", stopServer);
  $("configure").addEventListener("click", configureAgent);
  $("agent-select").addEventListener("change", onAgentChange);
  $("clear-console").addEventListener("click", () => ($("console").innerHTML = ""));
  $("copy-snippet").addEventListener("click", () => {
    navigator.clipboard.writeText($("result-snippet").textContent ?? "");
  });
  $("reveal-config").addEventListener("click", () => {
    if (lastConfigPath) invoke("reveal_path", { path: lastConfigPath }).catch(() => {});
  });
  $("browse").addEventListener("click", async () => {
    try {
      const dir = await window.__TAURI__.dialog.open({ directory: true, title: "Select Defold project root" });
      if (dir) {
        $("project_root").value = dir;
        scheduleSave();
      }
    } catch (e) {
      appendLog("meta", `Folder picker unavailable: ${e}`);
    }
  });
  for (const id of ["host", "port", "project_root", "node_path", "java_home"]) {
    $(id).addEventListener("input", scheduleSave);
    $(id).addEventListener("change", scheduleSave);
  }

  appendLog("meta", "Defold MCP desktop ready. Configure host/port, press Start, then connect your agents.");
  await refreshStatus();
  await refreshAgents();
  setInterval(refreshStatus, 2500);
}

init().catch((e) => appendLog("meta", `init failed: ${e}`));
