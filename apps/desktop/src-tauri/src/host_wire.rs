//! CHO host-wire codec (v1): NDJSON envelopes over an async byte pipe.
//!
//! Pure framing + validation. No child-process ownership, no timeouts; the
//! owning client wraps the handshake/RPC in `tokio::time::timeout`.

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// Maximum frame size in UTF-8 bytes, including the trailing LF.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

const MAX_JSON_DEPTH: usize = 64;
const MAX_ID_CHARS: usize = 128;
const MAX_CODE_CHARS: usize = 128;
const MAX_COMMAND_BYTES: usize = 80;

/// Read one complete LF-terminated frame and return the validated envelope.
///
/// Bounds raw bytes during accumulation, enforces strict UTF-8, accepts
/// CRLF, and rejects EOF even when the buffered bytes are complete JSON.
pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Value, String> {
    let mut raw: Vec<u8> = Vec::new();
    loop {
        let chunk: Vec<u8> = {
            let buffered = reader
                .fill_buf()
                .await
                .map_err(|e| format!("host pipe read error: {e}"))?;
            if buffered.is_empty() {
                return Err("unexpected EOF before frame LF".to_string());
            }
            match buffered.iter().position(|b| *b == b'\n') {
                Some(pos) if raw.len() + pos + 1 <= MAX_FRAME_BYTES => {
                    buffered[..pos + 1].to_vec()
                }
                None if raw.len() + buffered.len() <= MAX_FRAME_BYTES => buffered.to_vec(),
                _ => return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes")),
            }
        };
        let complete = chunk.ends_with(b"\n");
        let len = chunk.len();
        raw.extend_from_slice(&chunk);
        reader.consume(len);
        if complete {
            break;
        }
    }
    let text = std::str::from_utf8(&raw).map_err(|e| format!("frame is not valid UTF-8: {e}"))?;
    let body = text.strip_suffix('\n').unwrap_or(text);
    let body = body.strip_suffix('\r').unwrap_or(body);
    if body.contains('\n') || body.contains('\r') {
        return Err("frame must contain exactly one JSON envelope".to_string());
    }
    let value: Value =
        serde_json::from_str(body).map_err(|e| format!("frame is not valid JSON: {e}"))?;
    validate_envelope(&value)?;
    Ok(value)
}

/// Encode and write one `request` envelope as a single LF-terminated frame.
pub async fn write_request<W: AsyncWrite + Unpin>(
    writer: &mut W,
    generation: &str,
    request_id: &str,
    command: &str,
    args: Value,
) -> Result<(), String> {
    check_id_str(generation, "generation")?;
    check_id_str(request_id, "requestId")?;
    if !valid_command(command) {
        return Err("command must match [a-z][a-z0-9_]{0,79}".to_string());
    }
    if !args.is_object() {
        return Err("args must be a plain JSON object".to_string());
    }
    let envelope = json!({
        "v": 1,
        "type": "request",
        "generation": generation,
        "requestId": request_id,
        "command": command,
        "args": args,
    });
    validate_envelope(&envelope)?;
    let mut frame =
        serde_json::to_string(&envelope).map_err(|e| format!("request is not encodable: {e}"))?;
    frame.push('\n');
    if frame.len() > MAX_FRAME_BYTES {
        return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    writer
        .write_all(frame.as_bytes())
        .await
        .map_err(|e| format!("host pipe write error: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("host pipe flush error: {e}"))?;
    Ok(())
}

/// Accept the generation from a valid `ready` event for the actual child PID.
pub fn ready_generation(frame: &Value, pid: u32) -> Result<String, String> {
    validate_envelope(frame)?;
    if frame.get("type").and_then(Value::as_str) != Some("event") {
        return Err("ready envelope must be an event".to_string());
    }
    if frame.get("requestId").is_some_and(|v| !v.is_null()) {
        return Err("ready requestId must be null".to_string());
    }
    if frame.get("event").and_then(Value::as_str) != Some("ready") {
        return Err("event is not ready".to_string());
    }
    let payload = frame
        .get("payload")
        .filter(|p| p.is_object())
        .ok_or_else(|| "payload must be a plain JSON object".to_string())?;
    if payload.get("pid").and_then(Value::as_u64) != Some(u64::from(pid)) {
        return Err("ready pid does not match the child PID".to_string());
    }
    if payload.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported ready protocolVersion".to_string());
    }
    frame
        .get("generation")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "generation must be a nonempty string".to_string())
}

/// Match a frame against a pending request: `Ok(Ok(_))` success (even null),
/// `Ok(Err(_))` well-formed command error, outer `Err` protocol fault.
pub fn response(
    frame: Value,
    generation: &str,
    request_id: &str,
) -> Result<Result<Value, String>, String> {
    validate_envelope(&frame)?;
    if frame.get("generation").and_then(Value::as_str) != Some(generation) {
        return Err("stale generation".to_string());
    }
    if frame.get("requestId").and_then(Value::as_str) != Some(request_id) {
        return Err("requestId does not match the expected correlation".to_string());
    }
    match frame.get("type").and_then(Value::as_str) {
        Some("result") => Ok(Ok(frame.get("result").cloned().unwrap_or(Value::Null))),
        Some("error") => Ok(Err(frame
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())),
        _ => Err("envelope does not resolve an RPC request".to_string()),
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn check_id_str(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || utf16_len(value) > MAX_ID_CHARS {
        return Err(format!(
            "{label} must be a nonempty string of at most {MAX_ID_CHARS} chars"
        ));
    }
    Ok(())
}

fn check_id<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    match value {
        Value::String(s) => check_id_str(s, label).map(|()| s.as_str()),
        _ => Err(format!(
            "{label} must be a nonempty string of at most {MAX_ID_CHARS} chars"
        )),
    }
}

fn valid_command(command: &str) -> bool {
    let bytes = command.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_COMMAND_BYTES || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

fn container_depth(value: &Value) -> usize {
    usize::from(value.is_object() || value.is_array())
}

fn check_depth(root: &Value) -> Result<(), String> {
    let mut stack = vec![(root, container_depth(root))];
    while let Some((value, depth)) = stack.pop() {
        if depth > MAX_JSON_DEPTH {
            return Err(format!("JSON nesting depth exceeds {MAX_JSON_DEPTH}"));
        }
        match value {
            Value::Object(map) => {
                for child in map.values() {
                    stack.push((child, depth + container_depth(child)));
                }
            }
            Value::Array(items) => {
                for child in items {
                    stack.push((child, depth + container_depth(child)));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn check_canonical_size(value: &Value) -> Result<(), String> {
    let encoded =
        serde_json::to_string(value).map_err(|e| format!("frame is not encodable: {e}"))?;
    if encoded.len() + 1 > MAX_FRAME_BYTES {
        return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    Ok(())
}

fn validate_envelope(env: &Value) -> Result<(), String> {
    check_depth(env)?;
    let obj = env
        .as_object()
        .ok_or_else(|| "envelope must be a JSON object".to_string())?;
    if obj.get("v").and_then(Value::as_f64) != Some(1.0) {
        return Err("unsupported protocol version".to_string());
    }
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| matches!(*t, "request" | "result" | "error" | "event"))
        .ok_or_else(|| "unknown envelope type".to_string())?;
    check_id(obj.get("generation").unwrap_or(&Value::Null), "generation")?;
    let rid = obj.get("requestId").ok_or_else(|| "requestId field is required".to_string())?;
    if kind == "event" {
        if !rid.is_null() {
            check_id(rid, "requestId")?;
        }
    } else {
        check_id(rid, "requestId")?;
    }
    match kind {
        "request" => {
            if !obj.get("command").and_then(Value::as_str).is_some_and(valid_command) {
                return Err("command must match [a-z][a-z0-9_]{0,79}".to_string());
            }
            if !obj.get("args").is_some_and(Value::is_object) {
                return Err("args must be a plain JSON object".to_string());
            }
        }
        "result" => {
            if !obj.contains_key("result") {
                return Err("result envelope must carry a result field".to_string());
            }
        }
        "error" => {
            let err = obj
                .get("error")
                .filter(|e| e.is_object())
                .ok_or_else(|| "error must be a plain JSON object".to_string())?;
            if !err
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|c| !c.is_empty() && utf16_len(c) <= MAX_CODE_CHARS)
            {
                return Err(format!(
                    "error.code must be a nonempty string of at most {MAX_CODE_CHARS} chars"
                ));
            }
            if !err.get("message").is_some_and(Value::is_string) {
                return Err("error.message must be a string".to_string());
            }
        }
        _ => {
            if !obj
                .get("event")
                .and_then(Value::as_str)
                .is_some_and(|e| matches!(e, "ready" | "stream" | "stopping"))
            {
                return Err("unknown event name".to_string());
            }
            if !obj.get("payload").is_some_and(Value::is_object) {
                return Err("payload must be a plain JSON object".to_string());
            }
        }
    }
    check_canonical_size(env)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, BufReader};

    fn nest(levels: usize) -> Value {
        let mut value = Value::from(0);
        for _ in 0..levels {
            value = Value::Array(vec![value]);
        }
        value
    }

    fn ready(pid: Value, ver: Value) -> Value {
        json!({"v":1,"type":"event","generation":"gen-9","requestId":null,
            "event":"ready","payload":{"pid":pid,"protocolVersion":ver}})
    }

    #[tokio::test]
    async fn request_roundtrip_split_utf8_crlf() {
        let mut buf = Vec::new();
        write_request(&mut buf, "gen-1", "r1", "orch_run", json!({"text": "héllo ✓"}))
            .await
            .unwrap();
        let split = buf.iter().position(|&b| b == 0xC3).unwrap() + 1; // mid-`é`
        let (mut w, r) = duplex(65536);
        w.write_all(&buf[..split]).await.unwrap();
        w.write_all(&buf[split..]).await.unwrap();
        let mut br = BufReader::new(r);
        let frame = read_frame(&mut br).await.unwrap();
        assert_eq!(
            frame.get("command").and_then(Value::as_str),
            Some("orch_run")
        );
        let mut crlf = buf.clone();
        crlf.pop();
        crlf.extend_from_slice(b"\r\n");
        let mut r = BufReader::new(&crlf[..]);
        let frame = read_frame(&mut r).await.unwrap();
        assert_eq!(frame.get("requestId").and_then(Value::as_str), Some("r1"));
    }

    #[tokio::test]
    async fn rejects_oversize_and_unterminated_eof() {
        let big = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert!(read_frame(&mut BufReader::new(&big[..])).await.is_err());
        assert!(read_frame(&mut BufReader::new(&b"{\"v\":1}"[..])).await.is_err());
        let mut out = Vec::new();
        assert!(write_request(&mut out, "gen-1", "r1", "orch_run", json!({"pad": "a".repeat(MAX_FRAME_BYTES)}))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn depth_64_accepted_65_rejected() {
        for (levels, ok) in [(63, true), (64, false)] {
            let raw = format!(
                "{{\"v\":1,\"type\":\"result\",\"generation\":\"gen-1\",\"requestId\":\"r1\",\"result\":{}}}\n",
                serde_json::to_string(&nest(levels)).unwrap()
            );
            let mut r = BufReader::new(raw.as_bytes());
            assert_eq!(read_frame(&mut r).await.is_ok(), ok, "levels={levels}");
        }
    }

    #[tokio::test]
    async fn request_encoding_honors_exact_bound() {
        let mut probe = Vec::new();
        write_request(&mut probe, "gen-1", "r1", "orch_run", json!({"s": ""}))
            .await
            .unwrap();
        let pad = MAX_FRAME_BYTES - probe.len();
        let mut exact = Vec::new();
        write_request(&mut exact, "gen-1", "r1", "orch_run", json!({"s": "a".repeat(pad)}))
            .await
            .unwrap();
        assert_eq!(exact.len(), MAX_FRAME_BYTES);
        assert!(exact.ends_with(b"\n"));
        assert!(read_frame(&mut BufReader::new(&exact[..])).await.is_ok());
        let mut over = Vec::new();
        assert!(write_request(&mut over, "gen-1", "r1", "orch_run", json!({"s": "a".repeat(pad + 1)}))
            .await
            .is_err());
        let mut wide = Vec::new();
        assert!(write_request(&mut wide, "gen-1", "r1", "orch_run", json!({"s": "é".repeat(pad)}))
            .await
            .is_err());
        let mut bad = Vec::new();
        assert!(write_request(&mut bad, "gen-1", "r1", "Bad-Name", json!({})).await.is_err());
        assert!(write_request(&mut bad, "gen-1", "r1", "orch_run", json!([])).await.is_err());
        assert!(write_request(&mut bad, "", "r1", "orch_run", json!({})).await.is_err());
    }

    #[test]
    fn ready_accepts_exact_pid_and_version() {
        assert_eq!(ready_generation(&ready(json!(42), json!(1)), 42).unwrap(), "gen-9");
        assert!(ready_generation(&ready(json!(43), json!(1)), 42).is_err());
        assert!(ready_generation(&ready(json!(42), json!(2)), 42).is_err());
        assert!(ready_generation(&ready(json!(42.5), json!(1)), 42).is_err());
        assert!(ready_generation(&ready(json!("42"), json!(1)), 42).is_err());
    }

    #[test]
    fn ready_missing_requestid_rejected() {
        let frame = json!({"v":1,"type":"event","generation":"gen-9",
            "event":"ready","payload":{"pid":42,"protocolVersion":1}});
        assert!(ready_generation(&frame, 42).is_err());
    }

    #[test]
    fn stale_generation_and_wrong_id_reject() {
        let frame = json!({"v":1,"type":"result","generation":"gen-1","requestId":"r1","result":null});
        assert!(response(frame.clone(), "gen-2", "r1").is_err());
        assert!(response(frame.clone(), "gen-1", "r2").is_err());
        assert!(response(frame, "gen-1", "r1").unwrap().is_ok());
        let no_result = json!({"v":1,"type":"result","generation":"gen-1","requestId":"r1"});
        assert!(response(no_result, "gen-1", "r1").is_err());
    }

    #[test]
    fn fixture_driven_id_and_errorcode_bounds() {
        let raw = include_str!("../../server/host-wire-fixtures.json");
        let fixture: Value = serde_json::from_str(raw).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let field = case["field"].as_str().unwrap();
            let value = case["value"].as_str().unwrap();
            let repeat = case["repeat"].as_u64().unwrap() as usize;
            let valid = case["valid"].as_bool().unwrap();
            let repeated = value.repeat(repeat);
            let mut env = json!({"v":1,"type":"error","generation":"gen-1","requestId":"r1","error":{"code":"E","message":"test"}});
            match field {
                "generation" => env["generation"] = Value::String(repeated),
                "requestId" => env["requestId"] = Value::String(repeated),
                "errorCode" => env["error"]["code"] = Value::String(repeated),
                _ => panic!("unknown field {field}"),
            }
            assert_eq!(validate_envelope(&env).is_ok(), valid, "case: {}", case["name"].as_str().unwrap());
        }
    }

    #[test]
    fn version_1_0_accepted_non_numeric_rejected() {
        let ok = json!({"v":1.0,"type":"result","generation":"gen-1","requestId":"r1","result":null});
        assert!(validate_envelope(&ok).is_ok());
        let bad_bool = json!({"v":true,"type":"result","generation":"gen-1","requestId":"r1","result":null});
        assert!(validate_envelope(&bad_bool).is_err());
        let bad_str = json!({"v":"1","type":"result","generation":"gen-1","requestId":"r1","result":null});
        assert!(validate_envelope(&bad_str).is_err());
    }

    #[test]
    fn event_missing_requestid_rejected_null_accepted() {
        let no_rid = json!({"v":1,"type":"event","generation":"gen-1","event":"ready","payload":{"pid":1,"protocolVersion":1}});
        assert!(validate_envelope(&no_rid).is_err());
        let null_rid = json!({"v":1,"type":"event","generation":"gen-1","requestId":null,"event":"ready","payload":{"pid":1,"protocolVersion":1}});
        assert!(validate_envelope(&null_rid).is_ok());
    }

    #[test]
    fn command_error_is_not_a_protocol_fault() {
        let failure = json!({"v":1,"type":"error","generation":"gen-1","requestId":"r1",
            "error":{"code":"HOST_GONE","message":"dead"}});
        match response(failure, "gen-1", "r1") {
            Ok(Err(message)) => assert_eq!(message, "dead"),
            _ => panic!("expected well-formed command error"),
        }
        let event = json!({"v":1,"type":"event","generation":"gen-1","requestId":null,
            "event":"stream","payload":{}});
        assert!(response(event, "gen-1", "r1").is_err());
        let request = json!({"v":1,"type":"request","generation":"gen-1","requestId":"r1",
            "command":"orch_run","args":{}});
        assert!(response(request, "gen-1", "r1").is_err());
    }
}
