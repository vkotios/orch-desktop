use serde_json::{json, Value};
use std::process::Command;

/// Invokes the bundled Node 24 bridge (`apps/desktop/server/bridge.mjs`) or `orch/bin/orch.mjs`
/// directly from Tauri commands so Tauri and WebView share one canonical implementation.
fn call_node_bridge(command: &str, args: Value) -> Result<Value, String> {
    let payload = json!({ "command": command, "args": args }).to_string();
    let script = r#"
      import { handleBridgeCommand } from './server/bridge.mjs';
      const req = JSON.parse(process.argv[1]);
      handleBridgeCommand(req.command, req.args)
        .then(res => process.stdout.write(JSON.stringify({ ok: true, result: res })))
        .catch(err => { process.stderr.write(err.message || String(err)); process.exit(1); });
    "#;
    let output = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .arg(&payload)
        .output()
        .map_err(|e| format!("Failed to spawn node bridge: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(&stdout).map_err(|e| format!("Invalid bridge JSON: {e}"))?;
    Ok(parsed["result"].clone())
}

#[tauri::command]
fn discover_harnesses() -> Result<Value, String> {
    call_node_bridge("discover_harnesses", json!({}))
}

#[tauri::command]
fn orch_dashboard() -> Result<Value, String> {
    call_node_bridge("orch_dashboard", json!({}))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![discover_harnesses, orch_dashboard])
        .run(tauri::generate_context!())
        .expect("error while running CHO Desktop");
}
