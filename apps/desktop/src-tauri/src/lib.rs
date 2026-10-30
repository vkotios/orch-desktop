mod host_job;
mod host_runtime;
mod host_wire;

use host_runtime::{HostConfig, HostRuntime};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent};
use tokio::sync::OnceCell;

type StartResult = Result<Arc<HostRuntime>, String>;

/// Sticky outcome of the single host start: either the runtime or its startup error.
struct HostSlot(OnceCell<StartResult>);

// Resource resolution can yield verbatim `\\?\` paths that Node mishandles.
fn plain(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

fn host_config(app: &AppHandle) -> Result<HostConfig, String> {
    let paths = app.path();
    let resource = |rel: &str| {
        paths
            .resolve(rel, BaseDirectory::Resource)
            .map(plain)
            .map_err(|e| format!("cannot resolve bundled resource {rel}: {e}"))
    };
    let state_root = paths
        .app_local_data_dir()
        .map_err(|e| format!("cannot resolve the application data directory: {e}"))?;
    Ok(HostConfig {
        node: resource("runtime/node.exe")?,
        script: resource("runtime/app/apps/desktop/server/host.mjs")?,
        state_root: plain(state_root).join("host-state"),
        timeouts: Default::default(),
    })
}

async fn host(app: &AppHandle) -> StartResult {
    app.state::<HostSlot>()
        .0
        .get_or_init(|| async {
            let cfg = host_config(app)?;
            HostRuntime::start(cfg)
                .await
                .map(Arc::new)
                .map_err(|e| format!("CHO could not start its bundled host. {e}"))
        })
        .await
        .clone()
}

async fn route(app: &AppHandle, command: &str) -> Result<Value, String> {
    host(app).await?.request(command, json!({})).await
}

#[tauri::command]
async fn discover_harnesses(app: AppHandle) -> Result<Value, String> {
    route(&app, "discover_harnesses").await
}

#[tauri::command]
async fn orch_dashboard(app: AppHandle) -> Result<Value, String> {
    route(&app, "orch_dashboard").await
}

// Debug-only: report host startup/health on stdout, then exit through the normal lifecycle.
fn smoke_requested() -> bool {
    cfg!(debug_assertions) && std::env::args().any(|a| a == "--native-host-smoke")
}

fn report_smoke(app: &AppHandle, outcome: StartResult) {
    let (line, code) = match outcome {
        Ok(host) => {
            let h = host.health();
            (json!({ "ok": true, "pid": h.pid, "generation": h.generation }), 0)
        }
        Err(error) => (json!({ "ok": false, "error": error }), 1),
    };
    println!("CHO_HOST_SMOKE {line}");
    app.exit(code);
}

fn stop_host(app: &AppHandle) {
    if let Some(Ok(host)) = app.state::<HostSlot>().0.get() {
        if let Err(e) = tauri::async_runtime::block_on(host.shutdown()) {
            eprintln!("CHO host shutdown: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(HostSlot(OnceCell::new()))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let outcome = host(&handle).await;
                if smoke_requested() {
                    report_smoke(&handle, outcome);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![discover_harnesses, orch_dashboard])
        .build(tauri::generate_context!())
        .expect("error while building CHO Desktop");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_host(handle);
        }
    });
}
