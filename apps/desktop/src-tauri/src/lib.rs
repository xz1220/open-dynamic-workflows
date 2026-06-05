//! Tauri shell for the Open Dynamic Workflows read-only client.
//!
//! The shell is deliberately thin: it owns NO run state. It spawns `odw serve`
//! as a sidecar, waits for the local HTTP server to answer, then points the
//! webview at it — the exact same SPA a browser would load from `odw serve`, so
//! there is one renderer and zero "native vs web" fork. Everything else here is
//! presentation glue: a tray item, a Dock badge fed by the web layer, native
//! notifications on run transitions, and "close hides, stays resident".
//!
//! Read-only invariant: nothing in this process starts, controls, or mutates a
//! run. It only launches the observer server and shows its UI.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// The loopback port the sidecar serves on. Fixed for v1 (one window, one
/// server); a later version can probe for a free port and pass it through.
const SERVE_PORT: u16 = 4317;

/// Where the sidecar is reachable once up.
fn serve_url() -> String {
    format!("http://127.0.0.1:{SERVE_PORT}")
}

/// Shared flag so we navigate the window to the server exactly once.
#[derive(Default)]
struct Navigated(Mutex<bool>);

/// The running `odw serve` child. Kept so a real app quit does not orphan it.
#[derive(Default)]
struct Sidecar(Mutex<Option<CommandChild>>);

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(child) = slot.take() {
                stop_sidecar_child(child);
            }
        }
    }
}

/// Payload the web layer emits when a run reaches a terminal state.
#[derive(Debug, Deserialize)]
struct RunTransition {
    name: String,
    state: String,
    #[serde(default)]
    agents: u32,
    #[serde(default)]
    failed: u32,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Navigated::default())
        .manage(Sidecar::default())
        .setup(|app| {
            spawn_sidecar(app.handle().clone());
            build_tray(app.handle())?;
            listen_for_notifications(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close hides the window but keeps the app (and the detached worker
            // it observes) alive — the observatory stays resident in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the ODW desktop shell")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => shutdown_sidecar(app),
            _ => {}
        });
}

/// Launch `odw serve` as a sidecar; when it is reachable, navigate the window.
fn spawn_sidecar(app: AppHandle) {
    let sidecar = match app.shell().sidecar("odw") {
        Ok(cmd) => cmd.args(["serve", "--port", &SERVE_PORT.to_string()]),
        Err(err) => {
            eprintln!("failed to locate the odw sidecar: {err}");
            return;
        }
    };

    let (mut rx, child) = match sidecar.spawn() {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("failed to spawn odw serve: {err}");
            return;
        }
    };
    let pid = child.pid();
    *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
    eprintln!("[odw] serve started: pid {pid}");

    // Drain the sidecar's stdout/stderr so it never blocks on a full pipe, and
    // surface fatal exits to the console.
    let app_for_log = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => eprintln!("[odw] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(payload) => {
                    let _ = app_for_log.state::<Sidecar>().0.lock().unwrap().take();
                    eprintln!("[odw] serve exited: {:?}", payload.code);
                    let _ = app_for_log.emit("sidecar:exited", payload.code);
                }
                _ => {}
            }
        }
    });

    // Poll the server until it answers, then navigate the webview to it once.
    tauri::async_runtime::spawn(async move {
        for _ in 0..100 {
            if probe(&serve_url()).await {
                navigate_once(&app);
                return;
            }
            tokio_sleep(Duration::from_millis(150)).await;
        }
        eprintln!("odw serve did not become ready in time");
    });
}

fn shutdown_sidecar(app: &AppHandle) {
    let child = app.state::<Sidecar>().0.lock().unwrap().take();
    if let Some(child) = child {
        stop_sidecar_child(child);
    }
}

fn stop_sidecar_child(child: CommandChild) {
    let pid = child.pid();
    if let Err(err) = child.kill() {
        eprintln!("[odw] failed to stop serve pid {pid}: {err}");
    } else {
        eprintln!("[odw] stopped serve pid {pid}");
    }
}

/// A dependency-free readiness probe: open a TCP connection to the port.
async fn probe(_url: &str) -> bool {
    use std::net::TcpStream;
    // A successful TCP connect to the loopback port means the server is listening.
    tauri::async_runtime::spawn_blocking(move || {
        TcpStream::connect(("127.0.0.1", SERVE_PORT)).is_ok()
    })
    .await
    .unwrap_or(false)
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// Point the main window at the running server — guarded so it happens once.
fn navigate_once(app: &AppHandle) {
    let state = app.state::<Navigated>();
    let mut done = state.0.lock().unwrap();
    if *done {
        return;
    }
    *done = true;

    if let Some(window) = app.get_webview_window("main") {
        let url = serve_url();
        match url.parse::<tauri::Url>() {
            Ok(parsed) => {
                let _ = window.navigate(parsed);
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(err) => eprintln!("bad serve url {url}: {err}"),
        }
    }
}

/// A minimal tray: show the window, or quit for real.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Open Dynamic Workflows", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Raise a native notification when the web layer reports a terminal transition.
fn listen_for_notifications(app: AppHandle) {
    let handle = app.clone();
    app.listen("run:transition", move |event| {
        let Ok(t) = serde_json::from_str::<RunTransition>(event.payload()) else {
            return;
        };
        let (title, body) = match t.state.as_str() {
            "failed" => (
                format!("{} failed", t.name),
                format!("{} of {} agents failed", t.failed, t.agents),
            ),
            "stopped" => (format!("{} stopped", t.name), "Run was stopped".to_string()),
            _ => (
                format!("{} finished", t.name),
                format!("{} agents", t.agents),
            ),
        };
        let _ = handle
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    });
}
