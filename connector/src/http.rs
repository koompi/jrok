//! An HTTP request from the server, proxied to the local app, answered the
//! way the jrok CLI answers (cli/src/index.ts, handleHttpRequest): streamed
//! when the server supports it, gzipped for the tunnel when the visitor
//! accepts it, chunks as binary frames, and one `@jrok:req` event per request.

use crate::tunnel::Conn;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Not passed to the app. Host comes from the app's own address, as with
/// Node's fetch (apps see `x-forwarded-host`).
const HOP_BY_HOP: &[&str] = &[
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length", "host",
];
/// A body of known size up to this is compressed in one go and sent as one chunk.
const GZIP_WHOLE_BODY_MAX: u64 = 1024 * 1024;

fn env_flag_off(name: &str) -> bool {
    std::env::var(name).map(|v| v.eq_ignore_ascii_case("false")).unwrap_or(false)
}

fn gzip_level() -> u32 {
    std::env::var("JROK_TUNNEL_GZIP_LEVEL").ok().and_then(|v| v.parse().ok()).unwrap_or(1).clamp(1, 9)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(32)
            .tcp_nodelay(true)
            .build()
            .expect("HTTP client")
    })
}

/// Time to the app's response headers; streaming then lasts as long as the app does.
fn headers_timeout() -> Duration {
    let ms: u64 = std::env::var("TUNNEL_REQUEST_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(120_000);
    Duration::from_millis(ms.saturating_sub(2_000).max(1_000))
}

/// "gzip" as a word, as the CLI's /\bgzip\b/.
fn has_word(haystack: &str, word: &str) -> bool {
    let h = haystack.to_ascii_lowercase();
    let bytes = h.as_bytes();
    let mut from = 0;
    while let Some(pos) = h[from..].find(word) {
        let start = from + pos;
        let end = start + word.len();
        let before = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before && after {
            return true;
        }
        from = end;
    }
    false
}

/// Text worth compressing (the CLI's COMPRESSIBLE_TYPE); never event streams.
fn compressible(content_type: &str) -> bool {
    let ct = content_type.trim().to_ascii_lowercase();
    if let Some(rest) = ct.strip_prefix("text/") {
        return !rest.starts_with("event-stream");
    }
    if let Some(rest) = ct.strip_prefix("application/") {
        return [
            "json", "javascript", "x-javascript", "xml", "xhtml+xml", "ld+json", "manifest+json",
            "rss+xml", "atom+xml", "graphql-response+json", "problem+json", "vnd.ms-fontobject",
        ]
        .iter()
        .any(|t| rest.starts_with(t));
    }
    ct.starts_with("image/svg+xml") || ct.starts_with("font/ttf") || ct.starts_with("font/otf")
}

/// The CLI's shouldGzipResponse.
fn should_gzip(conn: &Conn, method: &str, accept_encoding: &str, status: u16, headers: &reqwest::header::HeaderMap) -> bool {
    if env_flag_off("JROK_TUNNEL_GZIP") || !conn.has("gzip") {
        return false;
    }
    if method == "HEAD" || status == 204 || status == 304 {
        return false;
    }
    if !has_word(accept_encoding, "gzip") {
        return false;
    }
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !compressible(get("content-type")) || has_word(get("cache-control"), "no-transform") {
        return false;
    }
    match get("content-length").parse::<u64>() {
        Ok(length) => length >= 1024,
        Err(_) => true,
    }
}

/// Only encodings this client can decode, so the body it hands on is always plain.
fn decodable_accept_encoding(value: &str) -> Option<String> {
    let kept: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|t| {
            let name = t.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            matches!(name.as_str(), "gzip" | "deflate" | "br" | "identity")
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join(", "))
}

fn capped_header(headers: &Value, name: &str) -> Option<String> {
    headers[name].as_str().filter(|v| !v.is_empty()).map(|v| v.chars().take(300).collect())
}

struct Request {
    id: String,
    method: String,
    path: String,
    query: String,
    headers: Value,
    client_ip: String,
    client_geo: Value,
    started: Instant,
}

impl Request {
    /// One event per completed request (the worker turns these into Traffic Insights).
    fn event(&self, conn: &Conn, status: u16, outcome: &str, bytes: u64) {
        let mut payload = json!({
            "id": self.id,
            "method": self.method,
            "path": self.path,
            "status": status,
            "ip": self.client_ip,
            "ms": self.started.elapsed().as_millis() as u64,
            "bytes": bytes,
            "outcome": outcome,
        });
        if self.client_geo.is_object() {
            payload["geo"] = self.client_geo.clone();
        }
        if let Some(ua) = capped_header(&self.headers, "user-agent") {
            payload["ua"] = Value::String(ua);
        }
        if let Some(referer) = capped_header(&self.headers, "referer") {
            payload["ref"] = Value::String(referer);
        }
        conn.out.event("req", payload);
    }
}

pub async fn handle(conn: Arc<Conn>, message: Value) {
    let request = Request {
        id: message["requestId"].as_str().unwrap_or_default().to_string(),
        method: message["method"].as_str().unwrap_or("GET").to_string(),
        path: message["path"].as_str().unwrap_or("/").to_string(),
        query: message["query"].as_str().unwrap_or_default().to_string(),
        headers: message["headers"].clone(),
        client_ip: message["clientIp"].as_str().unwrap_or("unknown").to_string(),
        client_geo: message["clientGeo"].clone(),
        started: Instant::now(),
    };
    if request.id.is_empty() {
        return;
    }
    let abort = CancellationToken::new();
    conn.http_aborts.lock().unwrap().insert(request.id.clone(), abort.clone());
    proxy(&conn, &request, &message, &abort).await;
    conn.http_aborts.lock().unwrap().remove(&request.id);
}

async fn proxy(conn: &Arc<Conn>, request: &Request, message: &Value, abort: &CancellationToken) {
    let cfg = &conn.cfg;
    let url = format!("http://{}:{}{}{}", cfg.local_host, cfg.local_port, request.path, request.query);
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut builder = client().request(method.clone(), &url);

    let mut accept_encoding = String::new();
    if let Some(headers) = request.headers.as_object() {
        for (name, value) in headers {
            let Some(value) = value.as_str() else { continue };
            let lower = name.to_ascii_lowercase();
            if lower == "accept-encoding" {
                accept_encoding = value.to_string();
                if let Some(decodable) = decodable_accept_encoding(value) {
                    builder = builder.header("accept-encoding", decodable);
                }
                continue;
            }
            if HOP_BY_HOP.contains(&lower.as_str()) {
                continue;
            }
            if let (Ok(n), Ok(v)) = (
                reqwest::header::HeaderName::from_bytes(lower.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                builder = builder.header(n, v);
            }
        }
    }
    if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        if let Some(body) = message["body"].as_str() {
            let bytes = if message["bodyIsBase64"].as_bool() == Some(true) {
                B64.decode(body).unwrap_or_default()
            } else {
                body.as_bytes().to_vec()
            };
            builder = builder.body(bytes);
        }
    }

    let response = tokio::select! {
        r = tokio::time::timeout(headers_timeout(), builder.send()) => match r {
            Ok(Ok(response)) => response,
            Ok(Err(e)) => return fail_before_start(conn, request, &e.to_string()).await,
            Err(_) => return fail_before_start(conn, request, "timed out waiting for the app").await,
        },
        _ = abort.cancelled() => return fail_before_start(conn, request, "aborted").await,
    };

    let status = response.status().as_u16();
    let status_text = response.status().canonical_reason().unwrap_or("").to_string();
    let mut headers = Map::new();
    let mut set_cookie: Vec<String> = Vec::new();
    for name in response.headers().keys() {
        let values: Vec<&str> = response.headers().get_all(name).iter().filter_map(|v| v.to_str().ok()).collect();
        if values.is_empty() {
            continue;
        }
        if name.as_str() == "set-cookie" {
            set_cookie.extend(values.iter().map(|v| v.to_string()));
            headers.insert(name.to_string(), Value::String(values.last().unwrap().to_string()));
        } else {
            headers.insert(name.to_string(), Value::String(values.join(", ")));
        }
    }

    if !conn.has("stream") {
        // Old server: the whole response in one message.
        let body = tokio::select! {
            b = response.bytes() => b,
            _ = abort.cancelled() => return request.event(conn, 0, "aborted", 0),
        };
        match body {
            Ok(body) => {
                let mut reply = json!({
                    "type": "http_response", "requestId": request.id, "status": status, "statusText": status_text,
                    "headers": headers, "body": B64.encode(&body), "isBase64": true,
                });
                if set_cookie.len() > 1 {
                    reply["setCookie"] = json!(set_cookie);
                }
                conn.send_json(reply).await;
                request.event(conn, status, "buffered", body.len() as u64);
            }
            Err(e) => fail_before_start(conn, request, &e.to_string()).await,
        }
        return;
    }

    let gzip = should_gzip(conn, &request.method, &accept_encoding, status, response.headers());
    let known_length = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    // No length: the app produces it as it goes; the server tells nginx not to hold it.
    let streamed_by_app = known_length.is_none() && request.method != "HEAD";
    if gzip {
        headers.remove("content-length");
        headers.remove("content-encoding");
        headers.insert("content-encoding".into(), Value::String("gzip".into()));
        let vary = headers.get("vary").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if vary.is_empty() {
            headers.insert("vary".into(), Value::String("Accept-Encoding".into()));
        } else if !has_word(&vary, "accept-encoding") && !vary.contains('*') {
            headers.insert("vary".into(), Value::String(format!("{vary}, Accept-Encoding")));
        }
    }
    let mut start = json!({
        "type": "http_response_start", "requestId": request.id, "status": status, "statusText": status_text, "headers": headers,
    });
    if set_cookie.len() > 1 {
        start["setCookie"] = json!(set_cookie);
    }
    if gzip {
        start["encoding"] = json!("gzip");
    }
    if streamed_by_app {
        start["streamed"] = json!(true);
    }
    conn.send_json(start).await;

    let binary = !env_flag_off("JROK_BINARY_FRAMES") && conn.has("binchunk");
    let mut bytes_out: u64 = 0;
    let send_chunk = |chunk: Vec<u8>| {
        let conn = conn.clone();
        let id = request.id.clone();
        async move {
            if binary {
                conn.send_binary(crate::frames::response_chunk(&id, &chunk)).await;
            } else {
                conn.send_json(json!({ "type": "http_response_chunk", "requestId": id, "data": B64.encode(&chunk) })).await;
            }
        }
    };

    // A small body of known size: compressed whole, one chunk.
    if gzip && known_length.map(|l| l <= GZIP_WHOLE_BODY_MAX).unwrap_or(false) {
        let body = tokio::select! {
            b = response.bytes() => b,
            _ = abort.cancelled() => return request.event(conn, 0, "aborted", 0),
        };
        let body = match body {
            Ok(b) => b,
            Err(e) => return fail_mid_stream(conn, request, &e.to_string(), 0).await,
        };
        let level = gzip_level();
        let compressed = tokio::task::spawn_blocking(move || {
            let mut encoder = GzEncoder::new(Vec::with_capacity(body.len() / 3 + 64), Compression::new(level));
            let _ = encoder.write_all(&body);
            encoder.finish().unwrap_or_default()
        })
        .await
        .unwrap_or_default();
        if abort.is_cancelled() {
            return request.event(conn, 0, "aborted", 0);
        }
        bytes_out += compressed.len() as u64;
        send_chunk(compressed).await;
        conn.send_json(json!({ "type": "http_response_end", "requestId": request.id })).await;
        return request.event(conn, status, "streamed", bytes_out);
    }

    // Everything else streams; compressed text is flushed per chunk so a
    // streamed page still arrives as it is produced.
    let mut encoder = gzip.then(|| GzEncoder::new(Vec::new(), Compression::new(gzip_level())));
    let mut body = response.bytes_stream();
    loop {
        let next = tokio::select! {
            n = body.next() => n,
            _ = abort.cancelled() => return request.event(conn, 0, "aborted", bytes_out),
            _ = conn.closed.cancelled() => return request.event(conn, 0, "aborted", bytes_out),
        };
        match next {
            Some(Ok(chunk)) => {
                let out = match encoder.as_mut() {
                    Some(enc) => {
                        let _ = enc.write_all(&chunk);
                        let _ = enc.flush();
                        std::mem::take(enc.get_mut())
                    }
                    None => chunk.to_vec(),
                };
                if !out.is_empty() {
                    bytes_out += out.len() as u64;
                    send_chunk(out).await;
                }
            }
            Some(Err(e)) => return fail_mid_stream(conn, request, &e.to_string(), bytes_out).await,
            None => break,
        }
    }
    if let Some(enc) = encoder {
        let rest = enc.finish().unwrap_or_default();
        if !rest.is_empty() {
            bytes_out += rest.len() as u64;
            send_chunk(rest).await;
        }
    }
    conn.send_json(json!({ "type": "http_response_end", "requestId": request.id })).await;
    request.event(conn, status, "streamed", bytes_out);
}

async fn fail_before_start(conn: &Conn, request: &Request, error: &str) {
    conn.out.err(format!("❌ Error forwarding request: {error}"));
    request.event(conn, 502, "error", 0);
    conn.send_json(json!({
        "type": "http_response", "requestId": request.id, "status": 502, "statusText": "Bad Gateway",
        "headers": { "Content-Type": "text/plain" },
        "body": format!("Error connecting to local service: {error}"),
    }))
    .await;
}

async fn fail_mid_stream(conn: &Conn, request: &Request, error: &str, bytes: u64) {
    conn.out.err(format!("❌ Error forwarding request: {error}"));
    request.event(conn, 0, "stream_error", bytes);
    conn.send_json(json!({ "type": "http_response_error", "requestId": request.id, "error": error })).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressible_types_match_the_cli() {
        for ct in ["text/html", "text/plain; charset=utf-8", "application/json", "application/javascript; charset=UTF-8", "image/svg+xml", "application/ld+json"] {
            assert!(compressible(ct), "{ct}");
        }
        for ct in ["text/event-stream", "image/png", "application/octet-stream", "video/mp4", ""] {
            assert!(!compressible(ct), "{ct}");
        }
    }

    #[test]
    fn gzip_as_a_word() {
        assert!(has_word("gzip, deflate, br", "gzip"));
        assert!(has_word("br;q=1, GZIP;q=0.5", "gzip"));
        assert!(!has_word("x-gzipped", "gzip"));
        assert!(!has_word("deflate, br", "gzip"));
    }

    #[test]
    fn only_decodable_encodings_are_asked_for() {
        assert_eq!(decodable_accept_encoding("gzip, deflate, br, zstd").as_deref(), Some("gzip, deflate, br"));
        assert_eq!(decodable_accept_encoding("zstd").as_deref(), None);
    }
}
