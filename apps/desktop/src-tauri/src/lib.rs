mod host_job;
mod host_runtime;
mod host_wire;
#[cfg(test)]
mod host_runtime_test;

use host_runtime::{HostConfig, HostRuntime};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
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

#[tauri::command]
async fn discover_harnesses(app: AppHandle, args: Option<Value>) -> Result<Value, String> {
    route_with_args(&app, "discover_harnesses", args.unwrap_or_else(|| json!({}))).await
}

#[tauri::command]
async fn orch_dashboard(app: AppHandle, args: Option<Value>) -> Result<Value, String> {
    route_with_args(&app, "orch_dashboard", args.unwrap_or_else(|| json!({}))).await
}

/// Generic host RPC for orch mutations and other allow-listed commands.
#[tauri::command]
async fn host_invoke(app: AppHandle, command: String, args: Option<Value>) -> Result<Value, String> {
    route_with_args(&app, &command, args.unwrap_or_else(|| json!({}))).await
}

// Fixed native-chat slice: each command carries its literal host command
// name, takes the real UI args payload (never an empty object), and rejects
// a non-object at the route before anything is written to the host.
async fn route_with_args(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    if !args.is_object() {
        return Err(format!("native command {command} requires an object args payload"));
    }
    host(app).await?.request(command, args).await
}

#[tauri::command]
async fn native_chat_validate_project(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_validate_project", args).await
}

#[tauri::command]
async fn native_chat_prepare_project(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_prepare_project", args).await
}

#[tauri::command]
async fn direct_chat_send(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "direct_chat_send", args).await
}

#[tauri::command]
async fn native_chat_poll(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_poll", args).await
}

#[tauri::command]
async fn native_chat_respond(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_respond", args).await
}

#[tauri::command]
async fn native_chat_answer(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_answer", args).await
}

#[tauri::command]
async fn direct_chat_cancel(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "direct_chat_cancel", args).await
}

#[tauri::command]
async fn native_chat_close(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_close", args).await
}

#[tauri::command]
async fn native_chat_list_conversations(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_list_conversations", args).await
}

#[tauri::command]
async fn native_chat_hydrate_conversation(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_hydrate_conversation", args).await
}

#[tauri::command]
async fn native_chat_save_draft(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_save_draft", args).await
}

#[tauri::command]
async fn native_chat_get_draft(app: AppHandle, args: Value) -> Result<Value, String> {
    route_with_args(&app, "native_chat_get_draft", args).await
}

#[tauri::command]
async fn native_pick_project_folder(window: WebviewWindow) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a project folder")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let chosen = rx
        .await
        .map_err(|e| format!("folder picker channel closed: {e}"))?;
    match chosen {
        None => Ok(None),
        Some(fp) => {
            let path = fp
                .into_path()
                .map_err(|e| format!("cannot resolve chosen folder path: {e}"))?;
            let path = plain(path);
            path.into_os_string()
                .into_string()
                .map(Some)
                .map_err(|_| "chosen folder path contains non-Unicode characters".to_string())
        }
    }
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
        .plugin(tauri_plugin_dialog::init())
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
        .invoke_handler(tauri::generate_handler![
            discover_harnesses,
            orch_dashboard,
            host_invoke,
            native_chat_validate_project,
            native_chat_prepare_project,
            direct_chat_send,
            native_chat_poll,
            native_chat_respond,
            native_chat_answer,
            direct_chat_cancel,
            native_chat_close,
            native_chat_list_conversations,
            native_chat_hydrate_conversation,
            native_chat_save_draft,
            native_chat_get_draft,
            native_pick_project_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building CHO Desktop");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_host(handle);
        }
    });
}
