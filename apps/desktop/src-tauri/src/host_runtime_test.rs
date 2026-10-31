//! Exercise the production parent-exit watcher without a subsequent RPC.
#![cfg(windows)]

use crate::host_runtime::{HostConfig, HostRuntime, Timeouts};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, timeout};
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

// An owned directory is removed even when an assertion panics. The runtime is
// declared later, so its Drop terminates the job before this directory drops.
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("cho-watchdog-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&path).expect("create unique fixture directory");
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf { self.0.join(name) }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

// Open a read-only wait handle while the process is known to be alive; unlike
// PID polling, this remains tied to the original process even if a PID is reused.
fn process_handle(pid: u32) -> OwnedHandle {
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let raw = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    assert!(!raw.is_null(), "open process {pid} for wait: {}", std::io::Error::last_os_error());
    unsafe { OwnedHandle::from_raw_handle(raw) }
}
fn exited(handle: &OwnedHandle) -> bool {
    match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => true,
        WAIT_TIMEOUT => false,
        other => panic!("process wait failed: {other}"),
    }
}
async fn wait_until(mut predicate: impl FnMut() -> bool, deadline: Duration, what: &str) {
    timeout(deadline, async {
        while !predicate() { sleep(Duration::from_millis(10)).await; }
    }).await.unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}
fn json_path(path: &Path) -> String {
    serde_json::to_string(&path.to_string_lossy().as_ref()).unwrap()
}

#[tokio::test]
async fn parent_exit_stops_owned_grandchild_without_further_rpc() {
    let fixture = Fixture::new();
    let script = fixture.path("host.js");
    let heartbeat = fixture.path("heartbeat");
    let child_pid = fixture.path("child-pid");
    let release = fixture.path("release-parent");
    // Spawn only in response to startup ping: HostRuntime has assigned the
    // parent to its job before sending that ping. Child stdio cannot keep the
    // parent's host pipes open, and ordinary spawn inherits the job.
    let source = format!(r#"
const fs = require('node:fs');
const {{ spawn }} = require('node:child_process');
const readline = require('node:readline');
const heartbeat = {heartbeat}, childPid = {child_pid}, release = {release};
if (process.argv[2] === 'child') {{
  fs.writeFileSync(childPid, String(process.pid));
  setInterval(() => fs.appendFileSync(heartbeat, 'x'), 40);
}} else {{
  const generation = 'watch-fixture';
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  send({{v:1,type:'event',requestId:null,generation,event:'ready',payload:{{pid:process.pid,protocolVersion:1}}}});
  readline.createInterface({{input:process.stdin}}).on('line', line => {{
    const request = JSON.parse(line);
    if (request.command !== 'ping') return;
    spawn(process.execPath, [__filename, 'child'], {{shell:false, windowsHide:true, stdio:'ignore'}});
    send({{v:1,type:'result',requestId:request.requestId,generation,result:{{ok:true,pid:process.pid}}}});
    const timer = setInterval(() => {{ if (fs.existsSync(release)) {{ clearInterval(timer); process.exit(0); }} }}, 10);
  }});
}}
"#, heartbeat=json_path(&heartbeat), child_pid=json_path(&child_pid), release=json_path(&release));
    std::fs::write(&script, source).expect("write fake host");
    let node = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".runtime").join("node.exe");
    let runtime = HostRuntime::start(HostConfig {
        node, script, state_root: fixture.0.clone(), timeouts: Timeouts::default(),
    }).await.expect("start real HostRuntime with prepared Node");
    let parent = process_handle(runtime.health().pid);
    wait_until(|| std::fs::metadata(&heartbeat).map(|m| m.len() >= 2).unwrap_or(false),
        Duration::from_secs(10), "grandchild heartbeats").await;
    let pid: u32 = std::fs::read_to_string(&child_pid).expect("child PID").parse().expect("numeric child PID");
    let child = process_handle(pid);
    assert!(!exited(&parent) && !exited(&child), "both fixture processes must be alive");
    std::fs::write(&release, "exit").expect("release parent");
    wait_until(|| exited(&parent), Duration::from_secs(3), "parent exit").await;
    // No request, terminate, shutdown or runtime drop occurs before this check.
    wait_until(|| exited(&child), Duration::from_secs(1), "watchdog to stop grandchild").await;
    assert!(exited(&child));
    drop(runtime);
}
