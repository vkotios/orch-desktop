//! One app-owned, long-lived Node host: spawn, handshake, serial RPC, shutdown.
//! Any wire fault poisons the connection: the owned tree is terminated and the
//! request is never replayed or respawned.

use crate::host_job::Job;
use crate::host_wire::{read_frame, ready_generation, response, write_request};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, MutexGuard};
use tokio::time::{timeout, timeout_at, Instant};

const MAX_HANDSHAKE: Duration = Duration::from_secs(10);
const STDERR_TAIL_BYTES: usize = 4096;
const NATIVE_COMMANDS: [&str; 3] = ["ping", "discover_harnesses", "orch_dashboard"];
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Timeouts {
    /// Covers the ready event and the first ping; clamped to 10 seconds.
    pub handshake: Duration,
    /// Per request, from call entry: queue admission, write and response read.
    /// Poison cleanup may add up to one `shutdown` phase.
    pub request: Duration,
    /// Per bounded phase of shutdown and of post-termination reaping.
    pub shutdown: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            handshake: MAX_HANDSHAKE,
            request: Duration::from_secs(30),
            shutdown: Duration::from_secs(3),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct HostConfig {
    pub node: PathBuf,
    pub script: PathBuf,
    /// Used as both the working directory and `ORCH_STATE_ROOT`.
    pub state_root: PathBuf,
    pub timeouts: Timeouts,
}

#[derive(Clone, Debug)]
pub(crate) struct Health {
    pub pid: u32,
    pub generation: String,
}

struct Conn {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    closed: Option<String>,
}

pub(crate) struct HostRuntime {
    job: Arc<Job>,
    health: Health,
    timeouts: Timeouts,
    stderr: Arc<StdMutex<Vec<u8>>>,
    conn: Mutex<Conn>,
}

/// Exclusive connection access. While `armed`, request bytes may be on the wire:
/// dropping it (caller cancellation) terminates the owned tree and closes the
/// connection before the lock is released, so no later request can dispatch.
struct Admitted<'a> {
    c: MutexGuard<'a, Conn>,
    job: &'a Job,
    armed: bool,
}

impl Drop for Admitted<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let note = cleanup_note(self.job.terminate());
        let _ = self.c.child.start_kill();
        self.c.stdin = None;
        let why = format!(
            "host connection interrupted; request outcome unknown and not retried: caller cancelled the in-flight call{note}"
        );
        self.c.closed.get_or_insert(why);
    }
}

async fn exchange(
    c: &mut Conn,
    generation: &str,
    id: &str,
    command: &str,
    args: Value,
) -> Result<Result<Value, String>, String> {
    let stdin = c.stdin.as_mut().ok_or("host stdin is closed")?;
    write_request(stdin, generation, id, command, args).await?;
    response(read_frame(&mut c.stdout).await?, generation, id)
}

async fn reap(job: &Job, child: &mut Child, wait: Duration) -> Result<(), String> {
    let terminated = job.terminate();
    let _ = child.start_kill();
    let waited = match timeout(wait, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("waiting for the host failed: {e}")),
        Err(_) => Err("host did not exit after termination".to_string()),
    };
    match (terminated, waited) {
        (Ok(()), waited) => waited,
        (Err(t), Ok(())) => Err(t),
        (Err(t), Err(w)) => Err(format!("{t}; {w}")),
    }
}

fn drain(mut err: ChildStderr, tail: Arc<StdMutex<Vec<u8>>>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 1024];
        while let Ok(n) = err.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
            t.extend_from_slice(&buf[..n]);
            let excess = t.len().saturating_sub(STDERR_TAIL_BYTES);
            t.drain(..excess);
        }
    })
}

fn tail_note(tail: &StdMutex<Vec<u8>>) -> String {
    let t = tail.lock().unwrap_or_else(|p| p.into_inner());
    match String::from_utf8_lossy(&t).trim() {
        "" => String::new(),
        text => format!("; host stderr: {text}"),
    }
}

fn cleanup_note(result: Result<(), String>) -> String {
    result.err().map(|e| format!("; cleanup: {e}")).unwrap_or_default()
}

impl HostRuntime {
    pub(crate) async fn start(cfg: HostConfig) -> Result<HostRuntime, String> {
        for (label, path) in [("Node runtime", &cfg.node), ("host script", &cfg.script)] {
            if !path.is_absolute() || !path.is_file() {
                return Err(format!("bundled {label} is missing at {}", path.display()));
            }
        }
        if !cfg.state_root.is_absolute() {
            return Err("host state root must be absolute".to_string());
        }
        std::fs::create_dir_all(&cfg.state_root)
            .map_err(|e| format!("cannot create host state directory {}: {e}", cfg.state_root.display()))?;
        let t = cfg.timeouts;
        let job = Arc::new(Job::new()?);
        let mut cmd = Command::new(&cfg.node);
        cmd.arg(&cfg.script)
            .current_dir(&cfg.state_root)
            .env("ORCH_STATE_ROOT", &cfg.state_root)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot launch bundled Node host {}: {e}", cfg.node.display()))?;
        let (Some(pid), Some(stdin), Some(stdout), Some(stderr_pipe)) =
            (child.id(), child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let note = cleanup_note(reap(&job, &mut child, t.shutdown).await);
            return Err(format!("bundled host started without piped stdio{note}"));
        };
        if let Err(e) = job.assign_child(&child) {
            let note = cleanup_note(reap(&job, &mut child, t.shutdown).await);
            return Err(format!("cannot place the host in its owned job: {e}{note}"));
        }
        let stderr = Arc::new(StdMutex::new(Vec::new()));
        let stderr_task = drain(stderr_pipe, stderr.clone());
        let mut conn =
            Conn { child, stdin: Some(stdin), stdout: BufReader::new(stdout), next_id: 0, closed: None };
        let handshake = timeout(t.handshake.min(MAX_HANDSHAKE), async {
            let generation = ready_generation(&read_frame(&mut conn.stdout).await?, pid)?;
            conn.next_id = 1;
            let pong = exchange(&mut conn, &generation, "r1", "ping", json!({}))
                .await?
                .map_err(|m| format!("ping rejected: {m}"))?;
            if pong.get("ok") != Some(&Value::Bool(true))
                || pong.get("pid").and_then(Value::as_u64) != Some(u64::from(pid))
            {
                return Err("ping reply did not confirm the host".to_string());
            }
            Ok::<String, String>(generation)
        })
        .await;
        let generation = match handshake {
            Ok(Ok(generation)) => generation,
            other => {
                let why = match other {
                    Ok(Err(e)) => e,
                    _ => "no valid ready event and ping before the startup deadline".to_string(),
                };
                let note = cleanup_note(reap(&job, &mut conn.child, t.shutdown).await);
                let _ = timeout(Duration::from_millis(500), stderr_task).await;
                return Err(format!("bundled host handshake failed: {why}{note}{}", tail_note(&stderr)));
            }
        };
        Ok(HostRuntime {
            job,
            health: Health { pid, generation },
            timeouts: t,
            stderr,
            conn: Mutex::new(conn),
        })
    }

    pub(crate) fn health(&self) -> &Health {
        &self.health
    }

    /// Native allow-list only; mutations are rejected before any dispatch.
    pub(crate) async fn request(&self, command: &str, args: Value) -> Result<Value, String> {
        if !NATIVE_COMMANDS.contains(&command) {
            return Err(format!("command not allowed over the native transport: {command}"));
        }
        let deadline = Instant::now() + self.timeouts.request;
        let Ok(guard) = timeout_at(deadline, self.conn.lock()).await else {
            return Err("request deadline exceeded while queued; request was not sent".to_string());
        };
        let mut a = Admitted { c: guard, job: &self.job, armed: false };
        if let Some(why) = &a.c.closed {
            return Err(why.clone());
        }
        if Instant::now() >= deadline {
            return Err("request deadline exceeded before dispatch; request was not sent".to_string());
        }
        a.c.next_id += 1;
        let id = format!("r{}", a.c.next_id);
        a.armed = true;
        let call = exchange(&mut a.c, &self.health.generation, &id, command, args);
        let result = match timeout_at(deadline, call).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(e)) => Err(self.poison(&mut a.c, &e).await),
            Err(_) => Err(self.poison(&mut a.c, "request deadline exceeded").await),
        };
        a.armed = false;
        result
    }

    async fn poison(&self, c: &mut Conn, why: &str) -> String {
        let note = cleanup_note(reap(&self.job, &mut c.child, self.timeouts.shutdown).await);
        c.stdin = None;
        let msg = format!(
            "host connection interrupted; request outcome unknown and not retried: {why}{note}{}",
            tail_note(&self.stderr)
        );
        c.closed = Some(msg.clone());
        msg
    }

    /// Lock-free route to kill the owned tree, usable while an RPC is stalled.
    pub(crate) fn terminate(&self) -> Result<(), String> {
        self.job.terminate()
    }

    /// Ask the host to stop, then always terminate and reap the owned tree.
    /// Total time is bounded by three `timeouts.shutdown` phases.
    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        let d = self.timeouts.shutdown;
        let graceful = timeout(d, async {
            let mut a = Admitted { c: self.conn.lock().await, job: &self.job, armed: false };
            if a.c.closed.is_some() {
                return Ok(());
            }
            a.c.next_id += 1;
            let id = format!("r{}", a.c.next_id);
            a.armed = true;
            exchange(&mut a.c, &self.health.generation, &id, "shutdown", json!({}))
                .await?
                .map_err(|m| format!("host rejected shutdown: {m}"))?;
            a.c.stdin = None;
            a.c.child.wait().await.map_err(|e| format!("waiting for the host failed: {e}"))?;
            a.c.closed = Some("host runtime has been shut down".to_string());
            a.armed = false;
            Ok::<(), String>(())
        })
        .await;
        let forced = self.terminate();
        let Ok(mut c) = timeout(d, self.conn.lock()).await else {
            let note = forced.err().map(|e| format!(" (termination also failed: {e})")).unwrap_or_default();
            return Err(format!("host connection stayed busy after forced termination{note}"));
        };
        c.stdin = None;
        c.closed.get_or_insert_with(|| "host runtime has been shut down".to_string());
        let reaped = match timeout(d, c.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("waiting for the host failed: {e}")),
            Err(_) => Err("host process was not reaped after forced termination".to_string()),
        };
        let mut faults = Vec::new();
        match graceful {
            Ok(Ok(())) => {}
            Ok(Err(e)) => faults.push(format!("graceful shutdown failed ({e})")),
            Err(_) => faults.push("graceful shutdown timed out".to_string()),
        }
        let tree_gone = forced.is_ok() && reaped.is_ok();
        if let Err(e) = forced {
            faults.push(format!("forced termination failed ({e})"));
        }
        if let Err(e) = reaped {
            faults.push(e);
        }
        if faults.is_empty() {
            return Ok(());
        }
        if tree_gone {
            faults.push("owned tree terminated".to_string());
        }
        Err(faults.join("; "))
    }
}

impl Drop for HostRuntime {
    fn drop(&mut self) {
        let _ = self.job.terminate();
    }
}
