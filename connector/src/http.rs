//! An HTTP request from the server, proxied to the local app, answered the
//! way the jrok CLI answers (cli/src/index.ts, handleHttpRequest): streamed
//! when the server supports it, gzipped for the tunnel when the visitor
//! accepts it, chunks as binary frames, and one `@jrok:req` event per request.
//!
//! The app is asked for gzip when the visitor and the server take it, else
//! for no encoding, and its own gzip (a stored .gz: WhiteNoise, gzip_static)
//! goes through as it is. A body of known size so keeps its length, which is
//! what lets the edge cache it; anything else the app sends compressed is
//! decoded, as Node's fetch does for the CLI.

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
/// Node's fetch (apps see `x-forwarded-host`). Accept-Encoding is chosen
/// here (`proxy`).
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

/// The client for the app. Never through a proxy: HTTP_PROXY or ALL_PROXY
/// in the worker's environment (set for Docker pulls, say) would get every
/// app's traffic, cookies and Authorization included, or break it (a proxy
/// can't reach 172.18.x.x); the CLI ignores them too. `gzip_through`: the
/// app's gzip goes through untouched, so this one doesn't decode gzip (br and
/// deflate, which it never asks for, still are).
fn client(gzip_through: bool) -> &'static reqwest::Client {
    static DECODING: OnceLock<reqwest::Client> = OnceLock::new();
    static GZIP_THROUGH: OnceLock<reqwest::Client> = OnceLock::new();
    let cell = if gzip_through { &GZIP_THROUGH } else { &DECODING };
    cell.get_or_init(|| build_client(gzip_through))
}

fn build_client(gzip_through: bool) -> reqwest::Client {
    let builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(32)
        .tcp_nodelay(true);
    let builder = if gzip_through { builder.no_gzip() } else { builder };
    builder.build().expect("HTTP client")
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

/// Gzip may cross the tunnel: the server takes it and it isn't turned off here.
fn tunnel_gzip(conn: &Conn) -> bool {
    !env_flag_off("JROK_TUNNEL_GZIP") && conn.has("gzip") && conn.has("stream")
}

/// What the app may compress with: gzip, which goes through the tunnel as
/// it is, when the visitor and the server take it; otherwise none, so a body
/// of known size keeps its length. Left to reqwest, it asked for gzip,
/// deflate and br even for a visitor who accepts none of them.
fn asked_encoding(tunnel_gzip: bool, visitor_accepts: &str) -> &'static str {
    if tunnel_gzip && has_word(visitor_accepts, "gzip") {
        "gzip"
    } else {
        "identity"
    }
}

/// The CLI's shouldGzipResponse.
fn should_gzip(conn: &Conn, method: &str, accept_encoding: &str, status: u16, headers: &reqwest::header::HeaderMap) -> bool {
    if !tunnel_gzip(conn) {
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
    // Still encoded (one reqwest can't decode): never compressed twice.
    if !matches!(get("content-encoding").trim(), "" | "identity") {
        return false;
    }
    match get("content-length").parse::<u64>() {
        Ok(length) => length >= 1024,
        Err(_) => true,
    }
}

/// A header value as Bun reads one: a character per byte (Latin-1), so bytes
/// that aren't ASCII (a Khmer path in a Location, a file name) reach the
/// visitor as the app sent them, as with Node's fetch in the CLI. Not UTF-8:
/// Bun's Headers refuses characters above U+00FF.
fn latin1(value: &reqwest::header::HeaderValue) -> String {
    value.as_bytes().iter().map(|&b| char::from(b)).collect()
}

/// The way back: what the server read as Latin-1 characters goes to the app
/// as those bytes (re-encoding them as UTF-8 garbled them). Characters above
/// U+00FF don't come from Bun; they go as UTF-8.
fn header_value(text: &str) -> Option<reqwest::header::HeaderValue> {
    match text.chars().map(|c| u8::try_from(c).ok()).collect::<Option<Vec<u8>>>() {
        Some(bytes) => reqwest::header::HeaderValue::from_bytes(&bytes).ok(),
        None => reqwest::header::HeaderValue::from_str(text).ok(),
    }
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
    let accept_encoding = request
        .headers
        .as_object()
        .and_then(|h| h.iter().find(|(name, _)| name.eq_ignore_ascii_case("accept-encoding")))
        .and_then(|(_, v)| v.as_str())
        .unwrap_or_default()
        .to_string();
    let asked = asked_encoding(tunnel_gzip(conn), &accept_encoding);
    let mut builder = client(asked == "gzip").request(method.clone(), &url).header("accept-encoding", asked);

    if let Some(headers) = request.headers.as_object() {
        for (name, value) in headers {
            let Some(value) = value.as_str() else { continue };
            let lower = name.to_ascii_lowercase();
            if lower == "accept-encoding" || HOP_BY_HOP.contains(&lower.as_str()) {
                continue;
            }
            if let (Ok(n), Some(v)) = (reqwest::header::HeaderName::from_bytes(lower.as_bytes()), header_value(value)) {
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
        let values: Vec<String> = response.headers().get_all(name).iter().map(latin1).collect();
        if values.is_empty() {
            continue;
        }
        if name.as_str() == "set-cookie" {
            set_cookie.extend(values.iter().cloned());
            headers.insert(name.to_string(), Value::String(values.last().unwrap().clone()));
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

    // The app's own gzip, asked for: on as it is, length and all.
    let app_gzip = asked == "gzip"
        && response
            .headers()
            .get("content-encoding")
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"gzip") || v.as_bytes().eq_ignore_ascii_case(b"x-gzip"));
    let gzip = !app_gzip && should_gzip(conn, &request.method, &accept_encoding, status, response.headers());
    let known_length = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    // No length: the app produces it as it goes; the server tells nginx not to hold it.
    let streamed_by_app = known_length.is_none() && request.method != "HEAD";
    if gzip || app_gzip {
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
    if gzip || app_gzip {
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
    fn header_bytes_survive_the_round_trip() {
        // é in Latin-1 (one byte), and ក in UTF-8 (three), as the app wrote them.
        for raw in [&b"caf\xe9"[..], "ក".as_bytes()] {
            let value = reqwest::header::HeaderValue::from_bytes(raw).unwrap();
            let text = latin1(&value);
            assert_eq!(text.chars().count(), raw.len());
            assert_eq!(header_value(&text).unwrap().as_bytes(), raw);
        }
        // Not from Bun: anything above U+00FF goes as UTF-8.
        assert_eq!(header_value("ក").unwrap().as_bytes(), "ក".as_bytes());
    }

    #[test]
    fn the_app_is_asked_for_gzip_or_for_nothing() {
        assert_eq!(asked_encoding(true, "gzip, deflate, br, zstd"), "gzip");
        assert_eq!(asked_encoding(true, "br;q=1, GZIP;q=0.5"), "gzip");
        // Nothing the tunnel carries: no encoding, so the length survives.
        assert_eq!(asked_encoding(true, "br, zstd"), "identity");
        assert_eq!(asked_encoding(true, ""), "identity");
        // The server can't take gzip (or JROK_TUNNEL_GZIP=false).
        assert_eq!(asked_encoding(false, "gzip"), "identity");
    }
}

/// Requests through the proxy to real local apps (the findings' scenarios).
#[cfg(test)]
mod proxy_tests {
    use crate::tunnel::{testing, Outbound};
    use flate2::write::{GzEncoder, ZlibEncoder};
    use flate2::Compression;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

    /// An HTTP app: `answer` gets the request head and returns the whole
    /// response. The heads it got come out of the receiver.
    async fn app(answer: fn(&str) -> Vec<u8>) -> (u16, mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (heads_tx, heads) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let heads_tx = heads_tx.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && matches!(s.read(&mut byte).await, Ok(1)) {
                        head.push(byte[0]);
                    }
                    let head = head.iter().map(|&b| b as char).collect::<String>();
                    let _ = s.write_all(&answer(&head)).await;
                    let _ = heads_tx.send(head);
                });
            }
        });
        (port, heads)
    }

    fn response(head: &str, body: &[u8]) -> Vec<u8> {
        let mut r = head.as_bytes().to_vec();
        r.extend_from_slice(body);
        r
    }

    fn script() -> Vec<u8> {
        "console.log('hello from a hashed asset');\n".repeat(2_200).into_bytes()
    }

    fn gzipped(body: &[u8]) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::best());
        e.write_all(body).unwrap();
        e.finish().unwrap()
    }

    /// WhiteNoise, gzip_static, Caddy's precompressed: the stored .gz with its
    /// length when the request accepts gzip, else the plain file.
    fn precompressed(head: &str) -> Vec<u8> {
        let wants_gzip = head.lines().any(|l| l.to_ascii_lowercase().starts_with("accept-encoding:") && l.to_ascii_lowercase().contains("gzip"));
        let cache = "cache-control: public, max-age=31536000, immutable\r\ncontent-type: application/javascript\r\nvary: Accept-Encoding\r\nconnection: close\r\n";
        if wants_gzip {
            let gz = gzipped(&script());
            response(&format!("HTTP/1.1 200 OK\r\n{cache}content-encoding: gzip\r\ncontent-length: {}\r\n\r\n", gz.len()), &gz)
        } else {
            response(&format!("HTTP/1.1 200 OK\r\n{cache}content-length: {}\r\n\r\n", script().len()), &script())
        }
    }

    /// What reached the edge: the start message, and the body from its chunks.
    fn answered(rx: &mut mpsc::UnboundedReceiver<Outbound>) -> (Value, Vec<u8>) {
        let (mut start, mut body) = (Value::Null, Vec::new());
        while let Ok(o) = rx.try_recv() {
            match o.message {
                Message::Text(t) => {
                    let m: Value = serde_json::from_str(&t).unwrap();
                    if m["type"] == "http_response_start" || m["type"] == "http_response" {
                        start = m;
                    }
                }
                Message::Binary(frame) => body.extend_from_slice(&frame[2 + frame[1] as usize..]),
                _ => {}
            }
        }
        (start, body)
    }

    fn request(path: &str, headers: Value) -> Value {
        json!({ "type": "http_request", "requestId": "r1", "method": "GET", "path": path, "query": "", "headers": headers })
    }

    fn gunzip(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes).read_to_end(&mut out).unwrap();
        out
    }

    #[tokio::test]
    async fn an_apps_own_gzip_goes_through_as_it_is_and_keeps_its_length() {
        let (port, mut heads) = app(precompressed).await;
        let (conn, mut sent, _lines) = testing::conn(port, &["stream", "binchunk", "gzip"]);
        super::handle(conn, request("/static/app.4f3a.js", json!({ "accept-encoding": "gzip, deflate, br, zstd" }))).await;
        let head = heads.recv().await.unwrap().to_ascii_lowercase();
        assert!(head.contains("\r\naccept-encoding: gzip\r\n"), "{head}");
        let (start, body) = answered(&mut sent);
        assert_eq!(start["encoding"], "gzip", "{start}");
        // Not streamed: the edge keeps nginx buffering, so the edge cache can hold it.
        assert!(start.get("streamed").is_none(), "{start}");
        assert_eq!(start["headers"]["cache-control"], "public, max-age=31536000, immutable");
        assert_eq!(body, gzipped(&script()), "the app's bytes, untouched");
    }

    #[tokio::test]
    async fn a_visitor_without_gzip_gets_the_plain_file_with_its_length() {
        let (port, mut heads) = app(precompressed).await;
        let (conn, mut sent, _lines) = testing::conn(port, &["stream", "binchunk", "gzip"]);
        super::handle(conn, request("/static/app.4f3a.js", json!({}))).await;
        let head = heads.recv().await.unwrap().to_ascii_lowercase();
        assert!(head.contains("\r\naccept-encoding: identity\r\n"), "{head}");
        let (start, body) = answered(&mut sent);
        assert!(start.get("streamed").is_none(), "{start}");
        assert!(start.get("encoding").is_none(), "{start}");
        assert_eq!(body, script());
    }

    /// An app that ignores Accept-Encoding: deflate, always.
    fn always_deflate(_head: &str) -> Vec<u8> {
        let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
        e.write_all(&script()).unwrap();
        let body = e.finish().unwrap();
        response(&format!("HTTP/1.1 200 OK\r\ncontent-type: application/javascript\r\ncontent-encoding: deflate\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()), &body)
    }

    /// An app that ignores Accept-Encoding: gzip, always.
    fn always_gzip(_head: &str) -> Vec<u8> {
        let gz = gzipped(&script());
        response(&format!("HTTP/1.1 200 OK\r\ncontent-type: application/javascript\r\ncontent-encoding: gzip\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", gz.len()), &gz)
    }

    #[tokio::test]
    async fn an_encoding_nobody_asked_for_is_still_decoded() {
        // Deflate to a gzip visitor: decoded, then gzipped for the tunnel.
        let (port, _heads) = app(always_deflate).await;
        let (conn, mut sent, _lines) = testing::conn(port, &["stream", "binchunk", "gzip"]);
        super::handle(conn, request("/a.js", json!({ "accept-encoding": "gzip" }))).await;
        let (start, body) = answered(&mut sent);
        assert_eq!(start["encoding"], "gzip", "{start}");
        assert_eq!(gunzip(&body), script());

        // Gzip to a visitor who asked for none: decoded.
        let (port, _heads) = app(always_gzip).await;
        let (conn, mut sent, _lines) = testing::conn(port, &["stream", "binchunk", "gzip"]);
        super::handle(conn, request("/a.js", json!({}))).await;
        let (start, body) = answered(&mut sent);
        assert!(start.get("encoding").is_none(), "{start}");
        assert!(start["headers"].get("content-encoding").is_none(), "{start}");
        assert_eq!(body, script());

        // A server without the gzip feature: never gzip in the tunnel.
        let (port, mut heads) = app(precompressed).await;
        let (conn, mut sent, _lines) = testing::conn(port, &["stream", "binchunk"]);
        super::handle(conn, request("/a.js", json!({ "accept-encoding": "gzip" }))).await;
        assert!(heads.recv().await.unwrap().to_ascii_lowercase().contains("\r\naccept-encoding: identity\r\n"));
        let (start, body) = answered(&mut sent);
        assert!(start.get("encoding").is_none(), "{start}");
        assert_eq!(body, script());
    }

    /// A Khmer-first app that doesn't percent-encode: a redirect to a Khmer
    /// path, a Khmer file name, cookies with non-ASCII bytes. It echoes the
    /// cookie bytes it got in a header of its own.
    fn khmer_app(head: &str) -> Vec<u8> {
        let cookie = head.lines().find_map(|l| l.strip_prefix("cookie: ")).unwrap_or("").to_string();
        let mut r = b"HTTP/1.1 302 Found\r\nlocation: /".to_vec();
        r.extend_from_slice("ទំព័រ".as_bytes());
        r.extend_from_slice(b"\r\ncontent-disposition: attachment; filename=\"");
        r.extend_from_slice("វិក្កយបត្រ.pdf".as_bytes());
        r.extend_from_slice(b"\"\r\nset-cookie: lang=");
        r.extend_from_slice("ខ្មែរ".as_bytes());
        r.extend_from_slice(b"\r\nset-cookie: city=Si\xe9m Reap\r\nx-cookie-seen: ");
        r.extend(cookie.chars().map(|c| c as u8));
        r.extend_from_slice(b"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        r
    }

    /// Bytes as Bun hands them over: one character per byte (Latin-1).
    fn as_bun_reads(bytes: &[u8]) -> String {
        bytes.iter().map(|&b| b as char).collect()
    }

    #[tokio::test]
    async fn header_bytes_pass_through_as_with_the_cli() {
        let (port, mut heads) = app(khmer_app).await;
        let (conn, mut sent, _lines) = testing::conn(port, &["stream", "binchunk", "gzip"]);
        // The visitor's browser sent the cookie as UTF-8; the server read it as Latin-1.
        let cookie = as_bun_reads("name=សុខា".as_bytes());
        super::handle(conn, request("/login", json!({ "cookie": cookie }))).await;
        let head = heads.recv().await.unwrap();
        assert!(head.contains(&format!("\r\ncookie: {cookie}\r\n")), "the app got other bytes: {head:?}");
        let (start, _) = answered(&mut sent);
        let headers = &start["headers"];
        assert_eq!(headers["location"], as_bun_reads("/ទំព័រ".as_bytes()), "{start}");
        assert_eq!(headers["content-disposition"], as_bun_reads("attachment; filename=\"វិក្កយបត្រ.pdf\"".as_bytes()), "{start}");
        assert_eq!(headers["x-cookie-seen"], cookie, "{start}");
        assert_eq!(start["setCookie"], json!([as_bun_reads("lang=ខ្មែរ".as_bytes()), as_bun_reads(b"city=Si\xe9m Reap")]), "{start}");
    }

    /// Runs only in the child process of the test below, with proxy variables set.
    #[tokio::test]
    #[ignore]
    async fn child_requests_ignore_proxy_variables() {
        let Ok(app_port) = std::env::var("JROK_TEST_APP_PORT") else { return };
        for gzip_through in [false, true] {
            let answer = super::build_client(gzip_through).get(format!("http://127.0.0.1:{app_port}/")).send().await.unwrap();
            assert_eq!(answer.text().await.unwrap(), "direct", "gzip_through {gzip_through}: the request went to the proxy");
        }
    }

    /// HTTP_PROXY or ALL_PROXY on a worker (set for Docker pulls, say) must
    /// not get every app's traffic, cookies and Authorization included: the
    /// CLI ignores them. A child process, so this one's environment is untouched.
    #[tokio::test]
    async fn proxy_variables_in_the_workers_environment_are_ignored() {
        let (proxy_port, _) = app(|_| response("HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\n", b"proxied")).await;
        let (app_port, _) = app(|_| response("HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\n", b"direct")).await;
        let proxy = format!("http://127.0.0.1:{proxy_port}");
        let child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "http::proxy_tests::child_requests_ignore_proxy_variables"])
            .env("HTTP_PROXY", &proxy)
            .env("http_proxy", &proxy)
            .env("ALL_PROXY", &proxy)
            .env("all_proxy", &proxy)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .env("JROK_TEST_APP_PORT", app_port.to_string())
            .output()
            .await
            .unwrap();
        let said = String::from_utf8_lossy(&child.stdout);
        assert!(said.contains("1 passed"), "{said}");
    }
}

