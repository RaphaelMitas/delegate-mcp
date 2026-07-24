use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, WindowEvent,
};

static TRAY_ICON: Mutex<Option<TrayIcon>> = Mutex::new(None);

fn data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("delegate-mcp"),
    )
}

fn pid_alive(pid: i64) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Runtime info of the daemon (port/token/pid), or null when the daemon is
/// not running. A daemon.json whose pid is dead is treated as stale.
#[tauri::command]
fn get_daemon_runtime() -> Result<Option<serde_json::Value>, String> {
    let Some(dir) = data_dir() else {
        return Err("cannot resolve home directory".into());
    };
    let path = dir.join("daemon.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid daemon.json: {e}"))?;
    match value.get("pid").and_then(|p| p.as_i64()) {
        Some(pid) if pid_alive(pid) => Ok(Some(value)),
        _ => Ok(None),
    }
}

#[tauri::command]
fn spawn_daemon() -> Result<String, String> {
    let candidates = [
        std::env::var("DELEGATE_MCP_BIN").unwrap_or_default(),
        "/opt/homebrew/bin/delegate-mcp".into(),
        "/usr/local/bin/delegate-mcp".into(),
        "delegate-mcp".into(),
    ];
    let dir = data_dir().ok_or("cannot resolve home directory")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log = fs::File::options()
        .append(true)
        .create(true)
        .open(dir.join("daemon.log"))
        .map_err(|e| e.to_string())?;

    for candidate in candidates.iter().filter(|c| !c.is_empty()) {
        let spawned = Command::new(candidate)
            .args(["daemon", "--foreground"])
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log.try_clone().map_err(|e| e.to_string())?)
            .spawn();
        if spawned.is_ok() {
            return Ok(candidate.clone());
        }
    }
    Err("delegate-mcp binary not found; install it with: brew install raphaelmitas/tap/delegate-mcp".into())
}

#[tauri::command]
fn set_tray_status(status: String) {
    let guard = TRAY_ICON.lock().unwrap();
    if let Some(ref tray) = *guard {
        let (title, tooltip) = match status.as_str() {
            "running" => ("▶", "Delegate — job running"),
            "stalled" => ("⚠", "Delegate — a job stalled"),
            "backend-down" => ("○", "Delegate — LM Studio unreachable"),
            _ => ("", "Delegate — idle"),
        };
        let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Delegate", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Delegate", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("Delegate — idle")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    *TRAY_ICON.lock().unwrap() = Some(tray);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_daemon_runtime,
            spawn_daemon,
            set_tray_status
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Menu-bar app: closing the window hides it, quit lives in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running delegate app");
}
